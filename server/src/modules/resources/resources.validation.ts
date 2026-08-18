/**
 * Resource request schemas.
 *
 * These are the contract for `/api/v1/resources`: the runtime validation, the
 * generated OpenAPI document and the frontend's generated types all derive from
 * them, so the three cannot drift apart.
 *
 * `businessId` appears in none of them and never will — the tenant is resolved
 * from the caller's membership, so accepting one here would be an authorisation
 * hole with a validation schema in front of it.
 */
import { z } from 'zod';
import { RESOURCE_TYPES } from '../../database/models/Resource';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mirrors the CHECK on `resources.color`. */
const HEX_COLOUR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const uuidSchema = z.string().uuid();

/** Sourced from the model so the enum cannot drift from the CHECK constraint. */
export const resourceTypeSchema = z.enum(RESOURCE_TYPES);

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
 * Validated rather than silently rewritten: a caller-chosen slug is what they
 * will reference from their own tooling, so they must not be surprised by the
 * identifier that is actually stored.
 */
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(60)
  .regex(SLUG_PATTERN, 'Use lowercase letters, numbers and single hyphens.');

const nameSchema = z.string().trim().min(1, 'A resource name is required.').max(160);

const colorSchema = z
  .string()
  .trim()
  .regex(HEX_COLOUR_PATTERN, 'Use a six-digit hex colour such as #1E88E5.')
  .nullable()
  .optional();

/** How many appointments may hold this resource at the same instant. */
const capacitySchema = z.number().int().min(1).max(1000);

/** NULL location = the resource is mobile and travels with the appointment. */
const locationIdSchema = uuidSchema.nullable().optional();

export const resourceIdParamsSchema = z.object({ id: uuidSchema }).strict();

export const serviceIdParamsSchema = z.object({ serviceId: uuidSchema }).strict();

export const listResourcesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    isActive: booleanQueryParam.optional(),
    type: resourceTypeSchema.optional(),
    locationId: uuidSchema.optional(),
  })
  .strict();

export const createResourceSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema.optional(),
    type: resourceTypeSchema.default('ROOM'),
    locationId: locationIdSchema,
    description: optionalText(2000),
    capacity: capacitySchema.default(1),
    color: colorSchema,
    isActive: z.boolean().default(true),
  })
  // strict(): a stray `businessId` in the body must be a loud 422, never a
  // silently ignored attempt to write into another tenant.
  .strict();

export const updateResourceSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    type: resourceTypeSchema.optional(),
    locationId: locationIdSchema,
    description: optionalText(2000),
    capacity: capacitySchema.optional(),
    color: colorSchema,
    isActive: z.boolean().optional(),
  })
  .strict()
  // An empty patch would write an audit row describing no change at all.
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update.');

/**
 * One line of a service's resource needs.
 *
 * A row either names the exact resource to reserve or names a type to draw
 * `quantity` free resources from — `service_resource_requirements_target_check`
 * rejects both-or-neither at the database level, so the same rule is spelled out
 * here to turn what would be a 500 into a readable 422.
 */
export const serviceResourceRequirementSchema = z
  .object({
    resourceId: uuidSchema.nullable().optional(),
    resourceType: resourceTypeSchema.nullable().optional(),
    quantity: z.number().int().min(1).max(100).default(1),
    // An optional requirement is reserved when possible and skipped when not, so
    // a nicety never blocks a booking.
    isRequired: z.boolean().default(true),
  })
  .strict()
  .refine(
    (row) => {
      const namesResource = (row.resourceId ?? null) !== null;
      const namesType = (row.resourceType ?? null) !== null;
      return namesResource !== namesType;
    },
    {
      message:
        'Set exactly one of resourceId (this specific resource) or resourceType ' +
        '(any resource of that type) — never both, and never neither.',
    },
  );

/**
 * A full replacement, not a delta: the client sends the set it wants to end up
 * with, so an empty array is a valid instruction meaning "this service needs no
 * resources at all".
 */
export const replaceServiceRequirementsSchema = z
  .object({
    requirements: z
      .array(serviceResourceRequirementSchema)
      .max(50)
      .refine((rows) => {
        // A resource id is a uuid, so the `type:` prefix cannot collide with one.
        const targets = rows.map((row) => row.resourceId ?? `type:${row.resourceType ?? ''}`);
        return new Set(targets).size === targets.length;
      }, 'Each resource or resource type may appear only once — raise quantity ' + 'instead of repeating a row.'),
  })
  .strict();

export type ResourceIdParams = z.infer<typeof resourceIdParamsSchema>;
export type ServiceIdParams = z.infer<typeof serviceIdParamsSchema>;
export type ListResourcesQuery = z.infer<typeof listResourcesQuerySchema>;
export type CreateResourceBody = z.infer<typeof createResourceSchema>;
export type UpdateResourceBody = z.infer<typeof updateResourceSchema>;
export type ServiceResourceRequirementInput = z.infer<typeof serviceResourceRequirementSchema>;
export type ReplaceServiceRequirementsBody = z.infer<typeof replaceServiceRequirementsSchema>;
