/**
 * Staff request schemas.
 *
 * These are the contract for `/api/v1/staff`: runtime validation, the generated
 * OpenAPI document and the frontend's types all derive from them, so the three
 * cannot drift apart.
 *
 * Neither `businessId` nor `userId` appears in any schema, and neither ever
 * will. The tenant comes from the caller's membership and the user comes from
 * the membership row named by `membershipId`; accepting either from the client
 * would be an authorisation hole with a validation schema in front of it.
 */
import { z } from 'zod';
import { isValidTimezone } from '../../utils/time';

/**
 * A staff member's working hours and leave are authored in this zone, so it must
 * be a named IANA identifier. A fixed offset such as `+05:30` cannot express DST
 * and would silently misplace every rule twice a year.
 */
export const staffTimezoneSchema = z
  .string()
  .trim()
  .refine(isValidTimezone, 'Must be an IANA timezone identifier such as Asia/Kolkata.');

/**
 * Optional free text that the client may also clear. An empty string collapses
 * to null so every consumer has one "absent" value to check instead of two.
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
 * `?isBookable=false` return exactly the rows it excludes. Spell the two
 * accepted literals out instead.
 */
const booleanQueryParam = z.enum(['true', 'false']).transform((value) => value === 'true');

const displayNameSchema = z.string().trim().min(1, 'A display name is required.').max(160);

/** Matches the `color ~ '^#[0-9A-Fa-f]{6}$'` check on staff_profiles. */
const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a six-digit hex colour such as #4F46E5.');

const avatarUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url('Enter a full URL including the scheme, e.g. https://cdn.example.com/a.png.')
  .nullable()
  .optional();

/**
 * NULL means "inherit the workspace default", 0 means "explicitly none" — so
 * these stay nullable rather than defaulting to 0, which would quietly opt a
 * profile out of the business-wide buffer policy.
 */
const bufferMinutesSchema = z.number().int().min(0).max(1440).nullable().optional();
const minNoticeMinutesSchema = z.number().int().min(0).max(525_600).nullable().optional();
const appointmentCapSchema = z.number().int().positive().max(1000).nullable().optional();

/** Matches `assignment_weight BETWEEN 1 AND 100`; higher wins more round-robin. */
const assignmentWeightSchema = z.number().int().min(1).max(100);

const sortOrderSchema = z.number().int().min(0).max(100_000);

export const staffIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const listStaffQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    isActive: booleanQueryParam.optional(),
    isBookable: booleanQueryParam.optional(),
  })
  .strict();

export const createStaffSchema = z
  .object({
    // The only accepted way to name the person: the membership proves they
    // already belong to this workspace, and the user id is read off that row.
    membershipId: z.string().uuid(),
    // Optional: defaults to the member's own name, which is what a workspace
    // wants in every case except a stage/professional name.
    displayName: displayNameSchema.optional(),
    title: optionalText(120),
    bio: optionalText(2000),
    avatarUrl: avatarUrlSchema,
    timezone: staffTimezoneSchema.optional(),
    color: colorSchema.optional(),
    defaultLocationId: z.string().uuid().nullable().optional(),
    isBookable: z.boolean().optional(),
    preBufferMinutes: bufferMinutesSchema,
    postBufferMinutes: bufferMinutesSchema,
    minNoticeMinutes: minNoticeMinutesSchema,
    maxDailyAppointments: appointmentCapSchema,
    maxWeeklyAppointments: appointmentCapSchema,
    assignmentWeight: assignmentWeightSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  // strict(): a stray `businessId` or `userId` in the body must be a loud 422,
  // never a silently ignored attempt to write into another tenant or account.
  .strict();

export const updateStaffSchema = z
  .object({
    // `membershipId` and `userId` are deliberately absent: rebinding a profile
    // to a different person would silently reassign their whole appointment
    // history. Delete the profile and create a new one instead.
    displayName: displayNameSchema.optional(),
    title: optionalText(120),
    bio: optionalText(2000),
    avatarUrl: avatarUrlSchema,
    timezone: staffTimezoneSchema.optional(),
    color: colorSchema.optional(),
    defaultLocationId: z.string().uuid().nullable().optional(),
    isBookable: z.boolean().optional(),
    preBufferMinutes: bufferMinutesSchema,
    postBufferMinutes: bufferMinutesSchema,
    minNoticeMinutes: minNoticeMinutesSchema,
    maxDailyAppointments: appointmentCapSchema,
    maxWeeklyAppointments: appointmentCapSchema,
    assignmentWeight: assignmentWeightSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  // An empty PATCH would write an audit row describing no change at all.
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const replaceStaffServicesSchema = z
  .object({
    // An empty array is meaningful — it withdraws the staff member from every
    // service — so this is required rather than optional. The cap bounds how
    // many join rows one request may rewrite.
    serviceIds: z.array(z.string().uuid()).max(200),
  })
  .strict();

export type StaffIdParams = z.infer<typeof staffIdParamsSchema>;
export type ListStaffQuery = z.infer<typeof listStaffQuerySchema>;
export type CreateStaffBody = z.infer<typeof createStaffSchema>;
export type UpdateStaffBody = z.infer<typeof updateStaffSchema>;
export type ReplaceStaffServicesBody = z.infer<typeof replaceStaffServicesSchema>;
