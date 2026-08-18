/**
 * Service catalogue request schemas.
 *
 * These are the contract for `/api/v1/services`: the runtime validation, the
 * generated OpenAPI document and the frontend's generated types all derive from
 * them, so the three cannot drift apart.
 *
 * `businessId` appears in none of them and never will — the tenant is resolved
 * from the caller's membership, so accepting one here would be an authorisation
 * hole with a validation schema in front of it.
 */
import { z } from 'zod';
import { ASSIGNMENT_STRATEGIES } from '../../database/models/Service';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mirrors the CHECK on `services.color` / `service_categories.color`. */
const HEX_COLOUR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const MAX_HORIZON_DAYS = 730;

/**
 * Notice can never usefully exceed the widest horizon the schema permits: past
 * that point no bookable slot exists at all.
 */
const MAX_NOTICE_MINUTES = MAX_HORIZON_DAYS * 24 * 60;

/** Sourced from the model so the enum cannot drift from the CHECK constraint. */
export const assignmentStrategySchema = z.enum(ASSIGNMENT_STRATEGIES);

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

/**
 * `z.coerce.boolean()` maps the string "false" to `true`, which would make
 * `?isActive=false` return exactly the rows it excludes. Spell the two accepted
 * literals out instead.
 */
const booleanQueryParam = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Validated rather than silently rewritten: a caller-chosen slug ends up in
 * their public booking URLs, so they must not be surprised by the identifier
 * that is actually stored.
 */
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(60)
  .regex(SLUG_PATTERN, 'Use lowercase letters, numbers and single hyphens.');

const colorSchema = z
  .string()
  .trim()
  .regex(HEX_COLOUR_PATTERN, 'Use a six-digit hex colour such as #1E88E5.')
  .nullable()
  .optional();

const sortOrderSchema = z.number().int().min(0).max(100_000);

const categoryNameSchema = z.string().trim().min(1, 'A category name is required.').max(120);
const serviceNameSchema = z.string().trim().min(1, 'A service name is required.').max(160);

const durationMinutesSchema = z.number().int().min(1).max(1440);

/**
 * Price lives in the smallest currency unit (paise, cents). A float here would
 * be a rounding bug that only surfaces on an invoice, so it is rejected outright
 * rather than coerced.
 */
const priceAmountSchema = z
  .number()
  .int('Give the price in the smallest currency unit (e.g. 1250 for ₹12.50), not a decimal.')
  .min(0)
  .max(100_000_000);

/** Above 1 this is a group service: one appointment, many participants. */
const capacitySchema = z.number().int().min(1).max(1000);

/**
 * The inheritance-aware overrides.
 *
 * NULL means "inherit from the workspace settings" and 0 means "explicitly
 * none", so these are `.nullable()` as well as `.optional()`: omitting the key
 * leaves the current value alone, while sending `null` deliberately hands the
 * decision back to the business defaults.
 */
const bufferMinutesSchema = z.number().int().min(0).max(1440).nullable().optional();
const minNoticeMinutesSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_NOTICE_MINUTES)
  .nullable()
  .optional();
const maxHorizonDaysSchema = z.number().int().min(1).max(MAX_HORIZON_DAYS).nullable().optional();
const slotIntervalMinutesSchema = z.number().int().min(1).max(480).nullable().optional();
const maxPerCustomerPerDaySchema = z.number().int().min(1).max(100).nullable().optional();

const uuidSchema = z.string().uuid();

/**
 * A repeated id would collide with the unique index on the join table, so it is
 * a client bug worth reporting rather than something to quietly deduplicate.
 */
const uniqueIds = (ids: string[]): boolean => new Set(ids).size === ids.length;

export const categoryIdParamsSchema = z.object({ id: uuidSchema }).strict();
export const serviceIdParamsSchema = z.object({ id: uuidSchema }).strict();

export const listCategoriesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    isActive: booleanQueryParam.optional(),
  })
  .strict();

export const createCategorySchema = z
  .object({
    name: categoryNameSchema,
    slug: slugSchema.optional(),
    description: optionalText(1000),
    color: colorSchema,
    sortOrder: sortOrderSchema.default(0),
    isActive: z.boolean().default(true),
  })
  // strict(): a stray `businessId` in the body must be a loud 422, never a
  // silently ignored attempt to write into another tenant.
  .strict();

export const updateCategorySchema = z
  .object({
    name: categoryNameSchema.optional(),
    slug: slugSchema.optional(),
    description: optionalText(1000),
    color: colorSchema,
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  // An empty patch would write an audit row describing no change at all.
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update.');

export const listServicesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    isActive: booleanQueryParam.optional(),
    isPublic: booleanQueryParam.optional(),
    categoryId: uuidSchema.optional(),
  })
  .strict();

export const createServiceSchema = z
  .object({
    name: serviceNameSchema,
    slug: slugSchema.optional(),
    categoryId: uuidSchema.nullable().optional(),
    description: optionalText(4000),
    durationMinutes: durationMinutesSchema,
    preBufferMinutes: bufferMinutesSchema,
    postBufferMinutes: bufferMinutesSchema,
    priceAmount: priceAmountSchema.default(0),
    capacity: capacitySchema.default(1),
    minNoticeMinutes: minNoticeMinutesSchema,
    maxHorizonDays: maxHorizonDaysSchema,
    slotIntervalMinutes: slotIntervalMinutesSchema,
    maxPerCustomerPerDay: maxPerCustomerPerDaySchema,
    requiresApproval: z.boolean().default(false),
    assignmentStrategy: assignmentStrategySchema.default('SMART_MATCH'),
    color: colorSchema,
    isPublic: z.boolean().default(true),
    isActive: z.boolean().default(true),
    sortOrder: sortOrderSchema.default(0),
  })
  .strict();

export const updateServiceSchema = z
  .object({
    name: serviceNameSchema.optional(),
    slug: slugSchema.optional(),
    categoryId: uuidSchema.nullable().optional(),
    description: optionalText(4000),
    durationMinutes: durationMinutesSchema.optional(),
    preBufferMinutes: bufferMinutesSchema,
    postBufferMinutes: bufferMinutesSchema,
    priceAmount: priceAmountSchema.optional(),
    capacity: capacitySchema.optional(),
    minNoticeMinutes: minNoticeMinutesSchema,
    maxHorizonDays: maxHorizonDaysSchema,
    slotIntervalMinutes: slotIntervalMinutesSchema,
    maxPerCustomerPerDay: maxPerCustomerPerDaySchema,
    requiresApproval: z.boolean().optional(),
    assignmentStrategy: assignmentStrategySchema.optional(),
    color: colorSchema,
    isPublic: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: sortOrderSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update.');

/**
 * A full replacement, not a delta: the client sends the set it wants to end up
 * with, so an empty array is a valid instruction meaning "nobody in particular".
 */
export const replaceServiceStaffSchema = z
  .object({
    staffProfileIds: z
      .array(uuidSchema)
      .max(200)
      .refine(uniqueIds, 'Each staff member may appear only once.'),
  })
  .strict();

export const replaceServiceLocationsSchema = z
  .object({
    // No rows means "offered everywhere", which is why an empty array is
    // meaningful rather than a mistake.
    locationIds: z
      .array(uuidSchema)
      .max(100)
      .refine(uniqueIds, 'Each location may appear only once.'),
  })
  .strict();

export type CategoryIdParams = z.infer<typeof categoryIdParamsSchema>;
export type ServiceIdParams = z.infer<typeof serviceIdParamsSchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
export type CreateCategoryBody = z.infer<typeof createCategorySchema>;
export type UpdateCategoryBody = z.infer<typeof updateCategorySchema>;
export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;
export type CreateServiceBody = z.infer<typeof createServiceSchema>;
export type UpdateServiceBody = z.infer<typeof updateServiceSchema>;
export type ReplaceServiceStaffBody = z.infer<typeof replaceServiceStaffSchema>;
export type ReplaceServiceLocationsBody = z.infer<typeof replaceServiceLocationsSchema>;
