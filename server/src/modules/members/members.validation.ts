/**
 * Member request schemas.
 *
 * These are the contract for `/api/v1/members`: runtime validation, the
 * generated OpenAPI document and the frontend's types all derive from them, so
 * the three cannot drift apart.
 *
 * Two things are deliberately absent and must stay absent.
 *
 * `businessId` appears in none of them. The workspace a request acts on is
 * resolved from the caller's own membership; accepting one here would be an
 * authorisation hole with a validation schema in front of it.
 *
 * `userId` appears in none of them either. An invitation names an *email
 * address*, and the service decides which user row that resolves to. Letting a
 * caller name a user id directly would turn this module into an oracle for
 * which accounts exist on the platform, and would let a workspace attach a
 * membership to somebody who never asked for one.
 */
import { z } from 'zod';
import { PERMISSION_EFFECTS } from '../../database/models/MembershipPermission';
import { ALL_PERMISSIONS, type PermissionKey } from '../auth/permissions';

/**
 * Sourced from the catalogue so the accepted keys cannot drift from the ones
 * the authorisation layer actually evaluates. The assertion is only there to
 * satisfy `z.enum`'s non-empty-tuple signature — `ALL_PERMISSIONS` is derived
 * from a literal object and is never empty.
 */
const permissionKeySchema = z.enum(ALL_PERMISSIONS as [PermissionKey, ...PermissionKey[]]);

/** Sourced from the model so the enum cannot drift from the CHECK constraint. */
const permissionEffectSchema = z.enum(PERMISSION_EFFECTS);

/**
 * Lowercased before it is ever compared or stored. The column is `citext`, so
 * casing cannot create a duplicate account — but the invitation path also looks
 * an address up before deciding whether to create a user, and that lookup has
 * to agree with the index.
 */
const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(255);

const personNameSchema = z.string().trim().min(1).max(100);

export const memberIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * `z.coerce.boolean()` maps the string "false" to `true`, which would make
 * `?includeRemoved=false` return exactly the rows it excludes. Spell the two
 * accepted literals out instead.
 */
const booleanQueryParam = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * REMOVED is not offered as a filter value: a removed membership is soft
 * deleted, so it is excluded by the paranoid scope rather than by its status,
 * and `includeRemoved` is the switch that brings those rows back.
 */
const listableStatusSchema = z.enum(['ACTIVE', 'INVITED', 'SUSPENDED']);

export const listMembersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(160).optional(),
    status: listableStatusSchema.optional(),
    roleId: z.string().uuid().optional(),
    /** Past members, so somebody who left can be found and re-invited. */
    includeRemoved: booleanQueryParam.default('false'),
  })
  .strict();

/**
 * `firstName` and `lastName` are only consulted when the address has no account
 * yet, because `users.first_name` and `users.last_name` are NOT NULL and a
 * placeholder derived from the address reads badly in every list that shows it.
 * They are optional rather than required so inviting a colleague who already
 * has an account cannot silently rewrite the name on their account.
 */
export const inviteMemberSchema = z
  .object({
    email: emailSchema,
    roleId: z.string().uuid(),
    firstName: personNameSchema.optional(),
    lastName: personNameSchema.optional(),
  })
  .strict();

/**
 * INVITED and REMOVED are deliberately missing, for the same reason
 * admin.validation.ts omits INVITED from its user-status schema: they are
 * states a flow produces, not states an operator sets. INVITED is written by
 * the invitation path and cleared by acceptance; REMOVED belongs to
 * `DELETE /members/:id`, which also soft deletes the row so the address can be
 * invited again.
 */
export const updateMemberSchema = z
  .object({
    roleId: z.string().uuid().optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  })
  .strict()
  // An empty PATCH would write an audit row describing no change at all.
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

const memberPermissionOverrideSchema = z
  .object({
    permission: permissionKeySchema,
    effect: permissionEffectSchema,
  })
  .strict();

/**
 * A full replacement, not a patch: the caller sends the complete override set
 * and whatever is missing is deleted. A merge would make "remove this DENY"
 * impossible to express, and the composite primary key already allows exactly
 * one effect per member and permission — so two entries for the same key are a
 * client bug that must not be resolved by silently picking one.
 */
export const replaceMemberPermissionsSchema = z
  .object({
    overrides: z.array(memberPermissionOverrideSchema).max(ALL_PERMISSIONS.length),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.overrides.forEach((override, index) => {
      if (seen.has(override.permission)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['overrides', index, 'permission'],
          message: `Duplicate override for ${override.permission}. Send each permission once.`,
        });
      }
      seen.add(override.permission);
    });
  });

/**
 * Acceptance carries the token from the invitation email. The token identifies
 * *which* invitation is being accepted; the bearer session is what proves the
 * caller is the person it was addressed to. Neither is sufficient alone, which
 * is why the endpoint is authenticated even though it takes a secret.
 */
export const acceptInvitationSchema = z
  .object({ token: z.string().trim().min(1).max(512) })
  .strict();

export type MemberIdParams = z.infer<typeof memberIdParamsSchema>;
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;
export type InviteMemberBody = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberBody = z.infer<typeof updateMemberSchema>;
export type ReplaceMemberPermissionsBody = z.infer<typeof replaceMemberPermissionsSchema>;
export type AcceptInvitationBody = z.infer<typeof acceptInvitationSchema>;
