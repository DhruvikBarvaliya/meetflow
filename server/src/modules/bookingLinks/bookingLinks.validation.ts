/**
 * Booking link request schemas.
 *
 * These are the single source of truth for the booking-links contract: the
 * runtime validation, the generated OpenAPI document and the frontend's
 * generated types all derive from them, so the three cannot drift apart.
 */
import { z } from 'zod';
import { BOOKING_LINK_TYPES, type BookingLinkType } from '../../database/models/BookingLink';

const uuidSchema = z.string().uuid();

/**
 * A repeated id would collide with the unique index on
 * (booking_link_id, service_id), so it is a client bug worth reporting rather
 * than something to quietly deduplicate.
 */
const uniqueIds = (ids: string[]): boolean => new Set(ids).size === ids.length;

/** Query strings are text: only these two literals are a boolean. */
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Optional free text the client may also clear. An empty string collapses to
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

export const bookingLinkTypeSchema = z.enum(BOOKING_LINK_TYPES);

const nameSchema = z.string().trim().min(1, 'A booking link name is required.').max(160);

/**
 * Matches what slugify() produces. Validated rather than silently rewritten:
 * the slug *is* the public URL, so a caller must never discover their campaign
 * lives at an address they did not choose.
 */
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.');

/**
 * An instant, which must carry its offset (`Z` or `+05:30`). A bare local time
 * would be read in whichever zone the server happens to run in.
 */
const instantSchema = z
  .string()
  .datetime({
    offset: true,
    message: 'Use an ISO-8601 timestamp including its offset, e.g. 2025-03-01T09:00:00Z.',
  })
  .transform((value) => new Date(value));

// ---------------------------------------------------------------------------
// Custom questions
// ---------------------------------------------------------------------------

/** The field types the public booking form knows how to render. */
export const CUSTOM_QUESTION_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'EMAIL',
  'PHONE',
  'URL',
  'DATE',
  'SELECT',
  'MULTI_SELECT',
  'CHECKBOX',
] as const;

export type CustomQuestionType = (typeof CUSTOM_QUESTION_TYPES)[number];

/** The types whose answer is picked from a fixed list rather than typed in. */
const CHOICE_QUESTION_TYPES: readonly CustomQuestionType[] = ['SELECT', 'MULTI_SELECT'];

export const customQuestionSchema = z
  .object({
    // The key becomes a property name inside appointments.answers, so it is
    // constrained to something that survives a JSON round trip and can be used
    // as a form field name without escaping.
    key: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        'Start with a lowercase letter and use only lowercase letters, digits and underscores.',
      ),
    label: z.string().trim().min(1, 'Every question needs a label.').max(200),
    type: z.enum(CUSTOM_QUESTION_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  })
  .strict()
  .superRefine((question, ctx) => {
    const isChoice = CHOICE_QUESTION_TYPES.includes(question.type);

    if (isChoice && question.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `A ${question.type} question needs at least one option to choose from.`,
      });
    }
    // Options on a free-text question would be stored, never rendered, and read
    // by whoever later writes the form as a promise the page does not keep.
    if (!isChoice && question.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `A ${question.type} question is free-form and cannot carry options.`,
      });
    }
    if (!uniqueIds(question.options)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Each option may appear only once.',
      });
    }
  });

const customQuestionsSchema = z
  .array(customQuestionSchema)
  .max(30, 'A booking form with more than 30 extra questions will not be filled in.')
  // Duplicate keys would overwrite each other in appointments.answers, silently
  // losing one of the answers the customer gave.
  .refine(
    (questions) => uniqueIds(questions.map((question) => question.key)),
    'Each question key may appear only once.',
  );

// ---------------------------------------------------------------------------
// Type / target agreement
// ---------------------------------------------------------------------------

const TARGET_FIELDS = ['serviceId', 'teamId', 'staffProfileId'] as const;
type TargetField = (typeof TARGET_FIELDS)[number];

/**
 * Mirrors the `booking_links_target_check` constraint: each type names exactly
 * one target column, and CATALOG names none because its offering comes from
 * booking_link_services instead.
 */
const TARGET_FIELD_BY_TYPE: Record<BookingLinkType, TargetField | null> = {
  SINGLE_SERVICE: 'serviceId',
  TEAM: 'teamId',
  STAFF: 'staffProfileId',
  CATALOG: null,
};

const TARGET_LABEL: Record<TargetField, string> = {
  serviceId: 'service',
  teamId: 'team',
  staffProfileId: 'staff member',
};

type TargetShape = Partial<Record<TargetField, string | null>>;

/**
 * The database only demands that the type's own target is present. This is
 * stricter, and rejects the leftovers it tolerates: a CATALOG link carrying a
 * serviceId stores an intention the public page will never act on.
 */
function refineTargets(
  type: BookingLinkType,
  value: TargetShape,
  ctx: z.RefinementCtx,
  options: { requirePresent: boolean },
): void {
  const expected = TARGET_FIELD_BY_TYPE[type];

  for (const field of TARGET_FIELDS) {
    const supplied = value[field] ?? null;

    if (field === expected) {
      if (options.requirePresent && supplied === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `A ${type} link must name the ${TARGET_LABEL[field]} it books.`,
        });
      }
      continue;
    }

    if (supplied !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `A ${type} link cannot also name a ${TARGET_LABEL[field]}.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const bookingLinkIdParamsSchema = z.object({ id: uuidSchema }).strict();

export const listBookingLinksQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    isActive: booleanQuery.optional(),
    type: bookingLinkTypeSchema.optional(),
    search: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const createBookingLinkSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema.optional(),
    description: optionalText(4000),
    type: bookingLinkTypeSchema.default('CATALOG'),
    serviceId: uuidSchema.nullable().optional(),
    teamId: uuidSchema.nullable().optional(),
    staffProfileId: uuidSchema.nullable().optional(),
    locationId: uuidSchema.nullable().optional(),
    // The services a CATALOG link offers, in the order they are shown. Accepted
    // here so a link is never published with an empty page.
    serviceIds: z
      .array(uuidSchema)
      .max(100)
      .refine(uniqueIds, 'Each service may appear only once.')
      .optional(),
    allowStaffSelection: z.boolean().default(true),
    requiresApproval: z.boolean().default(false),
    customQuestions: customQuestionsSchema.default([]),
    branding: z.record(z.unknown()).default({}),
    // Null means uncapped; the column's CHECK rejects a zero cap.
    maxBookingsTotal: z.number().int().positive().max(1_000_000).nullable().optional(),
    expiresAt: instantSchema.nullable().optional(),
    isActive: z.boolean().default(true),
  })
  // strict(): a stray `businessId` in the body must be a loud 422, never a
  // silently ignored attempt to write into another tenant.
  .strict()
  .superRefine((value, ctx) => {
    refineTargets(value.type, value, ctx, { requirePresent: true });

    if (value.serviceIds !== undefined && value.type !== 'CATALOG') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['serviceIds'],
        message: `A ${value.type} link books one target, so it has no list of offered services.`,
      });
    }
  });

export const updateBookingLinkSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    description: optionalText(4000),
    type: bookingLinkTypeSchema.optional(),
    serviceId: uuidSchema.nullable().optional(),
    teamId: uuidSchema.nullable().optional(),
    staffProfileId: uuidSchema.nullable().optional(),
    locationId: uuidSchema.nullable().optional(),
    allowStaffSelection: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
    customQuestions: customQuestionsSchema.optional(),
    branding: z.record(z.unknown()).optional(),
    maxBookingsTotal: z.number().int().positive().max(1_000_000).nullable().optional(),
    expiresAt: instantSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  // An empty patch would write an audit row describing no change at all.
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update.')
  .superRefine((patch, ctx) => {
    // Only contradictions *within the patch* are visible here. Whether the
    // merged row satisfies the constraint depends on the stored target, so the
    // service re-checks the result before it writes.
    if (patch.type !== undefined) {
      refineTargets(patch.type, patch, ctx, { requirePresent: false });
    }
  });

/**
 * A full replacement, not a delta: the client sends the set it wants to end up
 * with, and the array order is the order the public page lists them in.
 */
export const replaceBookingLinkServicesSchema = z
  .object({
    serviceIds: z
      .array(uuidSchema)
      .max(100)
      .refine(uniqueIds, 'Each service may appear only once.'),
  })
  .strict();

export type BookingLinkIdParams = z.infer<typeof bookingLinkIdParamsSchema>;
export type ListBookingLinksQuery = z.infer<typeof listBookingLinksQuerySchema>;
export type CreateBookingLinkBody = z.infer<typeof createBookingLinkSchema>;
export type UpdateBookingLinkBody = z.infer<typeof updateBookingLinkSchema>;
export type ReplaceBookingLinkServicesBody = z.infer<typeof replaceBookingLinkServicesSchema>;
export type CustomQuestion = z.infer<typeof customQuestionSchema>;
