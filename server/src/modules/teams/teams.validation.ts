/**
 * Team request schemas.
 *
 * These are the contract for `/api/v1/teams`: runtime validation, the generated
 * OpenAPI document and the frontend's types all derive from them, so the three
 * cannot drift apart.
 *
 * `businessId` appears in none of them, and never will: the tenant is resolved
 * from the caller's membership, so accepting one here would be an authorisation
 * hole with a validation schema in front of it.
 */
import { z } from 'zod';
import { TEAM_ASSIGNMENT_STRATEGIES } from '../../database/models/Team';

/** Sourced from the model so the enum cannot drift from the CHECK constraint. */
export const assignmentStrategySchema = z.enum(TEAM_ASSIGNMENT_STRATEGIES);

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const teamNameSchema = z.string().trim().min(1, 'A team name is required.').max(120);

/**
 * Optional: the server derives a slug from the name when none is given. When
 * one *is* given it is validated rather than silently rewritten, so the caller
 * cannot be surprised by the identifier that ends up in their URLs.
 */
const teamSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(60)
  .regex(SLUG_PATTERN, 'Use lowercase letters, numbers and single hyphens.');

const descriptionSchema = z.string().trim().max(1000).nullable();

/**
 * Matches the `weight BETWEEN 1 AND 100` check on team_members. Not coerced:
 * these only ever arrive in a JSON body, where a quoted number is a client bug.
 */
const weightSchema = z.number().int().min(1).max(100);

/** Lower number wins ties during assignment, so 0 is the strongest priority. */
const prioritySchema = z.number().int().min(0).max(1000);

export const teamIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const teamMemberParamsSchema = z
  .object({ id: z.string().uuid(), memberId: z.string().uuid() })
  .strict();

/**
 * `z.coerce.boolean()` maps the string "false" to `true`, which would make
 * `?isActive=false` return exactly the rows it excludes. Spell the two accepted
 * literals out instead.
 */
const booleanQueryParam = z.enum(['true', 'false']).transform((value) => value === 'true');

export const listTeamsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(120).optional(),
    isActive: booleanQueryParam.optional(),
    assignmentStrategy: assignmentStrategySchema.optional(),
  })
  .strict();

export const createTeamSchema = z
  .object({
    name: teamNameSchema,
    slug: teamSlugSchema.optional(),
    description: descriptionSchema.optional(),
    assignmentStrategy: assignmentStrategySchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const updateTeamSchema = z
  .object({
    name: teamNameSchema.optional(),
    slug: teamSlugSchema.optional(),
    description: descriptionSchema.optional(),
    assignmentStrategy: assignmentStrategySchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  // An empty PATCH would write an audit row describing no change at all.
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const addTeamMemberSchema = z
  .object({
    staffProfileId: z.string().uuid(),
    weight: weightSchema.optional(),
    priority: prioritySchema.optional(),
  })
  .strict();

export const updateTeamMemberSchema = z
  .object({
    weight: weightSchema.optional(),
    priority: prioritySchema.optional(),
    // Pausing a member keeps their history and their place in the team; the
    // join row has no soft delete, so this is how a member is taken out of
    // rotation without being removed.
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type TeamIdParams = z.infer<typeof teamIdParamsSchema>;
export type TeamMemberParams = z.infer<typeof teamMemberParamsSchema>;
export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;
export type CreateTeamBody = z.infer<typeof createTeamSchema>;
export type UpdateTeamBody = z.infer<typeof updateTeamSchema>;
export type AddTeamMemberBody = z.infer<typeof addTeamMemberSchema>;
export type UpdateTeamMemberBody = z.infer<typeof updateTeamMemberSchema>;
