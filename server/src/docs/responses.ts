/**
 * Response payload schemas for the published API contract.
 *
 * `openapi.ts` derives every *request* from the module's own `*.validation.ts`,
 * and until now deliberately described no *response* at all. The reasoning is
 * in that file's header and it was sound: MeetFlow shapes responses in its
 * controllers and Sequelize models rather than in a schema, so a zod mirror of
 * them is a second definition of something that already has one — precisely
 * what the generator exists to avoid.
 *
 * What that trade-off did not price in is that the second definition got
 * written anyway, just somewhere the contract could not see it. With
 * `SuccessEnvelope.data` left as `unknown`, no operation said what it returns,
 * so no client could be generated or validated from the document and
 * `client/src/types/api.ts` grew into a hand-maintained copy of exactly the
 * half the contract omitted. It then drifted, twice, into shipped bugs: four
 * enums that no longer matched the models, and a `lastName` typed non-nullable
 * that rendered "Jane null" to customers. The cost of not writing this file
 * turned out to be higher than the cost of writing it.
 *
 * So it is written, under three rules that are what keep it honest:
 *
 *  1. **Transcribed, never invented.** Every schema below is read off the code
 *     that builds the payload — the model's attribute list, the `attributes:`
 *     projection on the query, or the service's own exported view interface.
 *     Sections are ordered and named after the module they came from so the
 *     two can be compared side by side rather than hunted for.
 *  2. **Enums come from the model.** Statuses, types, scopes and sources are
 *     imported from the model that declares them, so renaming a status is a
 *     compile error here instead of a lie in the contract — the exact failure
 *     that put four wrong enums in front of clients.
 *  3. **Silence beats a guess.** A payload that could not be confirmed from
 *     the code is left out, and its operation keeps the untyped envelope. A
 *     wrong response schema is worse than an absent one, because a generated
 *     client trusts it and the mismatch surfaces as a runtime bug rather than
 *     as a missing type.
 *
 * Nothing here runs at request time: these schemas describe responses, they
 * never validate one. A drift between this file and a service is therefore a
 * documentation defect and not an outage, which is the reverse of the request
 * side and worth knowing when reading a diff.
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUSES,
  CANCELLED_BY_TYPES,
} from '../database/models/Appointment';
import {
  NOTIFICATION_TEMPLATE_CHANNELS,
  NOTIFICATION_TEMPLATE_KEYS,
} from '../database/models/NotificationTemplate';
import {
  APPOINTMENT_PARTICIPANT_ROLES,
  APPOINTMENT_PARTICIPANT_STATUSES,
} from '../database/models/AppointmentParticipant';
import { STATUS_HISTORY_ACTOR_TYPES } from '../database/models/AppointmentStatusHistory';
import { AUDIT_ACTOR_TYPES } from '../database/models/AuditLog';
import {
  AVAILABILITY_OVERRIDE_REASONS,
  AVAILABILITY_OVERRIDE_SCOPES,
} from '../database/models/AvailabilityOverride';
import { BLACKOUT_REASONS, BLACKOUT_SCOPES } from '../database/models/BlackoutPeriod';
import { BOOKING_LINK_TYPES } from '../database/models/BookingLink';
import { BUSINESS_STATUSES } from '../database/models/Business';
import { CUSTOMER_STATUSES } from '../database/models/Customer';
import { LOCATION_TYPES } from '../database/models/Location';
import { MEMBERSHIP_STATUSES } from '../database/models/Membership';
import { RESCHEDULE_ACTOR_TYPES } from '../database/models/RescheduleHistory';
import { RESOURCE_TYPES } from '../database/models/Resource';
import { ASSIGNMENT_STRATEGIES } from '../database/models/Service';
import { TEAM_ASSIGNMENT_STRATEGIES } from '../database/models/Team';
import { PERMISSION_EFFECTS } from '../database/models/MembershipPermission';
import { PLATFORM_ROLES, USER_STATUSES } from '../database/models/User';
import { WAITLIST_NOTIFY_CHANNELS, WAITLIST_STATUSES } from '../database/models/WaitlistEntry';
import { WEBHOOK_DELIVERY_STATUSES } from '../database/models/WebhookDelivery';
import { customQuestionSchema } from '../modules/bookingLinks/bookingLinks.validation';

// `openapi.ts` calls this too, but module evaluation order puts this file first
// — it is one of that file's imports — so the prototype must be patched here or
// the very first `.openapi()` below would be a call on undefined. The extension
// guards against being applied twice.
extendZodWithOpenApi(z);

/**
 * Every schema this module names, in declaration order, for `openapi.ts` to
 * register before it registers a single route.
 *
 * That order is load-bearing. The generator caches a component the first time
 * it meets one, so a schema whose first appearance is a nullable field —
 * `staffProfile: staffRef.nullable()` — gets cached *as nullable*, and every
 * other use of it then inherits a nullability that only one payload has.
 * Registering the definitions up front pins each component to its own
 * declaration and leaves the nullable use as a local variation of it.
 */
const definitions: Array<{ name: string; schema: z.ZodTypeAny }> = [];

/** Names a schema, so the generator emits it once and `$ref`s it thereafter. */
function named<T extends z.ZodTypeAny>(name: string, schema: T): T {
  const referenced = schema.openapi(name);
  definitions.push({ name, schema: referenced });
  return referenced;
}

/**
 * The registration list.
 *
 * A list rather than a call to `registry.register()` here, because the registry
 * lives in `openapi.ts` and that module imports this one: importing it back
 * would read the registry before it had been constructed.
 */
export const RESPONSE_SCHEMAS: ReadonlyArray<{ name: string; schema: z.ZodTypeAny }> = definitions;

// ---------------------------------------------------------------------------
// Primitives
//
// The three that matter are the ones a client gets wrong: what a timestamp
// looks like once it has been through JSON, what a calendar date looks like
// when it deliberately has no zone, and which columns are free-form bags.
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

/**
 * A `timestamptz` column as it appears in a response.
 *
 * Always UTC with a trailing `Z`, because that is what `Date.prototype.toJSON`
 * emits — never the workspace zone, whatever the accompanying `timezone` field
 * says. The zone is carried alongside the instant, not baked into it.
 */
const instant = z.string().datetime().openapi({ example: '2026-03-01T09:00:00.000Z' });
const nullableInstant = instant.nullable();

/**
 * A `DATEONLY` column. Kept as a string end to end: parsing it into a Date
 * would attach whichever offset the reader happens to run in, which is the one
 * property a calendar date must not have.
 */
const calendarDate = z.string().openapi({ format: 'date', example: '2026-03-01' });

/** Minutes from local midnight; may exceed 1440 for a window running overnight. */
const minuteOfDay = z.number().int();

/** A JSONB column: a free-form bag whose keys belong to the feature that wrote it. */
const jsonObject = z.record(z.unknown());

/** Every model carries these; they are omitted from the per-field commentary below. */
const timestamps = { createdAt: instant, updatedAt: instant };

/**
 * The soft-delete column on a paranoid model. Always null in a response — the
 * default scope filters deleted rows out before they reach one — but present,
 * because it is a column of the row rather than a computed field.
 */
const softDelete = { deletedAt: nullableInstant };

// ---------------------------------------------------------------------------
// References
//
// The abbreviated forms one payload uses to name a record owned by another.
// They are separate components rather than one shared "summary" because the
// `attributes:` projections genuinely differ: the diary needs a service colour
// to draw a block, the address book does not, and collapsing the two would
// promise a field that half the endpoints do not send.
// ---------------------------------------------------------------------------

const serviceRef = named(
  'ServiceRef',
  z
    .object({
      id: uuid,
      name: z.string(),
      slug: z.string(),
      durationMinutes: z.number().int(),
    })
    .openapi({ description: 'A service named from another payload — enough to label a row.' }),
);

const diaryServiceRef = named(
  'DiaryServiceRef',
  z
    .object({
      id: uuid,
      name: z.string(),
      slug: z.string(),
      durationMinutes: z.number().int(),
      color: z.string().nullable(),
    })
    .openapi({
      description:
        'A service as an appointment names it. Adds the colour, which is what a calendar ' +
        'draws the block in.',
    }),
);

const staffRef = named(
  'StaffRef',
  z
    .object({ id: uuid, displayName: z.string() })
    .openapi({ description: 'A provider named from another payload.' }),
);

const locationRef = named(
  'LocationRef',
  z.object({ id: uuid, name: z.string(), timezone: z.string() }).openapi({
    description:
      'A location named from an appointment payload. The zone travels with it: a workspace ' +
      'with branches in two zones renders each booking on its own site clock.',
  }),
);

const staffCardRef = named(
  'StaffCardRef',
  z
    .object({
      id: uuid,
      displayName: z.string(),
      title: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      color: z.string(),
      timezone: z.string(),
      isBookable: z.boolean(),
      isActive: z.boolean(),
    })
    .openapi({
      description:
        'A provider as a configuration screen lists them. Both flags are sent because both ' +
        'must hold before the person is offered: retired is not the same as temporarily ' +
        'withdrawn from booking.',
    }),
);

const locationCardRef = named(
  'LocationCardRef',
  z
    .object({
      id: uuid,
      name: z.string(),
      slug: z.string(),
      type: z.enum(LOCATION_TYPES),
      timezone: z.string(),
      isActive: z.boolean(),
    })
    .openapi({ description: 'A location as a configuration screen lists it.' }),
);

const serviceCategoryRef = named(
  'ServiceCategoryRef',
  z
    .object({
      id: uuid,
      name: z.string(),
      slug: z.string(),
      color: z.string().nullable(),
      sortOrder: z.number().int(),
      isActive: z.boolean(),
    })
    .openapi({ description: 'The category a service belongs to.' }),
);

const resourceRef = named(
  'ResourceRef',
  z
    .object({
      id: uuid,
      name: z.string(),
      slug: z.string(),
      type: z.enum(RESOURCE_TYPES),
      capacity: z.number().int(),
      color: z.string().nullable(),
      locationId: uuid.nullable(),
      isActive: z.boolean(),
    })
    .openapi({ description: 'A room or piece of equipment named from another payload.' }),
);

const customerRef = named(
  'CustomerRef',
  z
    .object({
      id: uuid,
      publicId: z.string(),
      firstName: z.string(),
      // Nullable, and this is the field that put "Jane null" on a screen: a
      // customer may be recorded by given name alone, so a client must join
      // rather than concatenate.
      lastName: z.string().nullable(),
    })
    .openapi({ description: 'Enough of a customer to label a row. No contact details.' }),
);

const customerContactRef = named(
  'CustomerContactRef',
  z
    .object({
      id: uuid,
      publicId: z.string(),
      firstName: z.string(),
      lastName: z.string().nullable(),
      email: z.string(),
      phone: z.string().nullable(),
      timezone: z.string(),
    })
    .openapi({
      description:
        'A customer with the address and number, sent only where the point of the read is to ' +
        'get in touch about one booking.',
    }),
);

const staffUserRef = named(
  'StaffUserRef',
  z
    .object({
      id: uuid,
      firstName: z.string(),
      lastName: z.string(),
      avatarUrl: z.string().nullable(),
    })
    .openapi({
      description:
        'The platform account behind a staff profile. Distinct from the profile itself, which ' +
        'carries the name and picture the workspace publishes.',
    }),
);

const roleRef = named(
  'RoleRef',
  z.object({ id: uuid, key: z.string(), name: z.string() }).openapi({
    description: 'A role by its stable key and its display name. Switch on `key`, show `name`.',
  }),
);

// ---------------------------------------------------------------------------
// Health and auth
// ---------------------------------------------------------------------------

export const versionInfoSchema = named(
  'VersionInfo',
  z
    .object({
      service: z.string().openapi({ example: 'meetflow-api' }),
      apiVersion: z.string().openapi({ example: 'v1' }),
      environment: z.string(),
      node: z.string().openapi({ example: 'v22.11.0' }),
    })
    .openapi({ description: 'Which build answered, for when several revisions run side by side.' }),
);

export const passwordPolicySchema = named(
  'PasswordPolicy',
  z
    .object({
      minLength: z.number().int(),
      maxLength: z.number().int(),
      requiresUppercase: z.boolean(),
      requiresLowercase: z.boolean(),
      requiresNumber: z.boolean(),
      appUrl: z.string(),
    })
    .openapi({
      description:
        'The rules the server enforces, so a sign-up form can enforce the same ones rather ' +
        'than round-tripping a 422.',
    }),
);

export const userPublicSchema = named(
  'UserPublic',
  z
    .object({
      id: uuid,
      email: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      fullName: z.string(),
      phone: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      platformRole: z.enum(PLATFORM_ROLES),
      status: z.enum(USER_STATUSES),
      timezone: z.string(),
      locale: z.string(),
      emailVerified: z.boolean(),
      lastLoginAt: nullableInstant,
      createdAt: instant,
    })
    .openapi({
      description:
        'The only shape of a platform account that crosses an API boundary. Built by an ' +
        'allow-list on the model rather than by deleting secrets from a row, so a new ' +
        'credential column cannot leak through an old serialiser.',
    }),
);

export const sessionSchema = named(
  'Session',
  z
    .object({
      user: userPublicSchema,
      accessToken: z.string(),
      refreshToken: z.string().openapi({
        description:
          'Also set as an httpOnly cookie. Browser clients should use the cookie and ignore ' +
          'this copy, which exists for native and server-to-server callers with no cookie jar.',
      }),
      tokenType: z.literal('Bearer'),
      expiresIn: z.number().int().openapi({ description: 'Access token lifetime in seconds.' }),
      expiresAt: instant,
    })
    .openapi({ description: 'A newly issued session.' }),
);

export const authContextSchema = named(
  'AuthContext',
  z
    .object({
      user: z.object({
        id: uuid,
        email: z.string(),
        platformRole: z.enum(PLATFORM_ROLES),
      }),
      memberships: z.array(
        z.object({
          membershipId: uuid,
          businessId: uuid,
          businessName: z.string(),
          businessSlug: z.string(),
          timezone: z.string(),
          roleKey: z.string(),
          roleName: z.string(),
          status: z.enum(MEMBERSHIP_STATUSES),
        }),
      ),
      customerProfiles: z
        .number()
        .int()
        .openapi({
          description:
            'How many workspaces hold a customer record for this person. Tells a new owner apart ' +
            'from a customer when neither holds a membership — without it both look identical.',
        }),
      activeWorkspace: z
        .object({
          businessId: uuid,
          businessSlug: z.string(),
          timezone: z.string(),
          roleKey: z.string(),
          staffProfileId: uuid.nullable(),
          permissions: z.array(z.string()).openapi({
            description: 'Effective permission keys, sorted — role grants plus GRANTs minus DENYs.',
          }),
        })
        .nullable()
        .openapi({
          description:
            'Null until a workspace has been resolved for the request, which a user belonging ' +
            'to several has to choose with X-Business-Id.',
        }),
    })
    .openapi({ description: 'Who the caller is, and which workspaces they may act in.' }),
);

export const sessionsRevokedSchema = named(
  'SessionsRevoked',
  z
    .object({ sessionsRevoked: z.number().int() })
    .openapi({ description: 'How many refresh tokens the sign-out-everywhere call revoked.' }),
);

export const emailVerifiedSchema = named(
  'EmailVerified',
  z.object({ verified: z.boolean() }).openapi({ description: 'The address is now confirmed.' }),
);

export const messageSchema = named(
  'Message',
  z.object({ message: z.string() }).openapi({
    description:
      'A human-readable acknowledgement. Deliberately the whole payload on the endpoints ' +
      'that must not reveal whether an account exists.',
  }),
);

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const workspaceSettingsShape = {
  businessId: uuid,
  slotIntervalMinutes: z.number().int(),
  defaultPreBufferMinutes: z.number().int(),
  defaultPostBufferMinutes: z.number().int(),
  minNoticeMinutes: z.number().int(),
  maxHorizonDays: z.number().int(),
  cancellationDeadlineMinutes: z.number().int(),
  rescheduleDeadlineMinutes: z.number().int(),
  allowCustomerCancel: z.boolean(),
  allowCustomerReschedule: z.boolean(),
  maxReschedulesPerAppointment: z.number().int(),
  requireApproval: z.boolean(),
  // Null is "no cap" on both; zero is rejected by the column's CHECK, so it can
  // never arrive and never means "none".
  maxBookingsPerCustomerPerDay: z.number().int().nullable(),
  maxBookingsPerStaffPerDay: z.number().int().nullable(),
  noShowGraceMinutes: z.number().int(),
  waitlistEnabled: z.boolean(),
  waitlistHoldMinutes: z.number().int(),
  waitlistAutoBook: z.boolean(),
  reminderOffsetsMinutes: z.array(z.number().int()).openapi({
    description: 'Minutes before the start at which each reminder fires, furthest out first.',
    example: [1440, 60],
  }),
  branding: jsonObject,
  ...timestamps,
};

export const workspaceSettingsSchema = named(
  'WorkspaceSettings',
  z.object(workspaceSettingsShape).openapi({
    description: 'The booking policy every slot search and booking is measured against.',
  }),
);

const workspaceShape = {
  id: uuid,
  slug: z.string(),
  name: z.string(),
  legalName: z.string().nullable(),
  description: z.string().nullable(),
  industry: z.string().nullable(),
  timezone: z.string(),
  currency: z.string(),
  locale: z.string(),
  logoUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  supportEmail: z.string().nullable(),
  supportPhone: z.string().nullable(),
  status: z.enum(BUSINESS_STATUSES),
  ownerUserId: uuid,
  ...timestamps,
  ...softDelete,
};

export const workspaceSchema = named(
  'Workspace',
  z
    .object({
      ...workspaceShape,
      settings: workspaceSettingsSchema.nullable().optional().openapi({
        description:
          'Joined on the read of the current workspace; absent from the update response.',
      }),
    })
    .openapi({ description: 'A tenant.' }),
);

export const workspaceMembershipSchema = named(
  'WorkspaceMembership',
  z
    .object({
      id: uuid,
      userId: uuid,
      businessId: uuid,
      roleId: uuid,
      status: z.enum(MEMBERSHIP_STATUSES),
      invitedByUserId: uuid.nullable(),
      invitedAt: nullableInstant,
      joinedAt: nullableInstant,
      ...timestamps,
      ...softDelete,
      user: z
        .object({
          id: uuid,
          email: z.string(),
          firstName: z.string(),
          lastName: z.string(),
          avatarUrl: z.string().nullable(),
          status: z.enum(USER_STATUSES),
        })
        .nullable(),
      role: roleRef.nullable(),
      staffProfile: z
        .object({ id: uuid, displayName: z.string(), isBookable: z.boolean() })
        .nullable(),
    })
    .openapi({
      description:
        'A membership row as the superseded `GET /workspace/members` returns it. `GET /members` ' +
        'answers the same question in the richer Member shape, with paging and filters.',
    }),
);

export const roleSchema = named(
  'Role',
  z
    .object({
      id: uuid,
      businessId: uuid.nullable().openapi({
        description: 'Null on the global templates the per-workspace roles are cloned from.',
      }),
      key: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      isSystem: z.boolean().openapi({
        description: 'A built-in role. The API refuses to rename or delete one.',
      }),
      ...timestamps,
      permissions: z.array(
        z.object({
          id: uuid,
          key: z.string(),
          category: z.string(),
          description: z.string(),
          ...timestamps,
        }),
      ),
    })
    .openapi({ description: 'An assignable role and everything it grants.' }),
);

export const slugAvailabilitySchema = named(
  'SlugAvailability',
  z.object({ slug: z.string(), available: z.boolean() }).openapi({
    description:
      'The normalised slug and whether it is free. Never says which workspace holds a taken ' +
      'one — that would make the check a directory of every tenant on the platform.',
  }),
);

export const createdWorkspaceSchema = named(
  'CreatedWorkspace',
  z
    .object({
      business: z.object(workspaceShape),
      membership: z.object({
        id: uuid,
        roleId: uuid,
        status: z.enum(MEMBERSHIP_STATUSES),
      }),
      staffProfile: z
        .object({ id: uuid, displayName: z.string() })
        .nullable()
        .openapi({ description: 'Created only when the owner made themselves bookable.' }),
    })
    .openapi({
      description: 'The workspace, the founding membership, and the owner’s own profile.',
    }),
);

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export const locationSchema = named(
  'Location',
  z
    .object({
      id: uuid,
      businessId: uuid,
      name: z.string(),
      slug: z.string(),
      type: z.enum(LOCATION_TYPES),
      description: z.string().nullable(),
      addressLine1: z.string().nullable(),
      addressLine2: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      postalCode: z.string().nullable(),
      countryCode: z.string().nullable(),
      timezone: z.string(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
      virtualMeetingUrl: z.string().nullable(),
      // Null means the site imposes no concurrency cap of its own; the
      // per-resource and per-provider limits still apply.
      capacity: z.number().int().nullable(),
      sortOrder: z.number().int(),
      isActive: z.boolean(),
      ...timestamps,
      ...softDelete,
    })
    .openapi({ description: 'A site appointments can be held at.' }),
);

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

const teamShape = {
  id: uuid,
  businessId: uuid,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  assignmentStrategy: z.enum(TEAM_ASSIGNMENT_STRATEGIES),
  isActive: z.boolean(),
  ...timestamps,
  ...softDelete,
};

export const teamSchema = named(
  'Team',
  z
    .object(teamShape)
    .openapi({ description: 'A group of providers that share an assignment strategy.' }),
);

export const teamMemberSchema = named(
  'TeamMember',
  z
    .object({
      id: uuid,
      teamId: uuid,
      staffProfileId: uuid,
      weight: z.number().int().openapi({ description: 'Biases round-robin assignment.' }),
      priority: z.number().int().openapi({ description: 'Breaks ties, lowest first.' }),
      isActive: z.boolean(),
      ...timestamps,
      staffProfile: staffCardRef.optional().openapi({
        description:
          'Joined when the team is read whole. Absent from the add and amend responses, which ' +
          'answer with the join row the caller just wrote.',
      }),
    })
    .openapi({ description: "One provider's place in a team." }),
);

export const teamDetailSchema = named(
  'TeamDetail',
  z
    .object({ ...teamShape, members: z.array(teamMemberSchema) })
    .openapi({ description: 'A team with its roster.' }),
);

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export const staffProfileSchema = named(
  'StaffProfile',
  z
    .object({
      id: uuid,
      businessId: uuid,
      userId: uuid,
      membershipId: uuid,
      displayName: z.string(),
      title: z.string().nullable(),
      bio: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      timezone: z.string(),
      color: z.string(),
      defaultLocationId: uuid.nullable(),
      isBookable: z.boolean(),
      // Null on every override means "inherit the workspace setting"; 0 means
      // "explicitly none", which is a different instruction.
      preBufferMinutes: z.number().int().nullable(),
      postBufferMinutes: z.number().int().nullable(),
      minNoticeMinutes: z.number().int().nullable(),
      maxDailyAppointments: z.number().int().nullable(),
      maxWeeklyAppointments: z.number().int().nullable(),
      lastAssignedAt: nullableInstant.openapi({
        description: 'Round-robin reads this to decide whose turn it is.',
      }),
      assignmentWeight: z.number().int(),
      sortOrder: z.number().int(),
      isActive: z.boolean(),
      ...timestamps,
      ...softDelete,
      user: staffUserRef.optional().openapi({
        description:
          'Joined on the list and the read. Absent from the create and amend responses, which ' +
          'answer with the row that was written.',
      }),
    })
    .openapi({ description: 'A bookable provider.' }),
);

export const staffServiceAssignmentSchema = named(
  'StaffServiceAssignment',
  z
    .object({
      id: uuid,
      serviceId: uuid,
      staffProfileId: uuid,
      durationMinutesOverride: z.number().int().nullable(),
      priceAmountOverride: z.number().int().nullable(),
      priority: z.number().int(),
      weight: z.number().int(),
      isActive: z.boolean(),
      ...timestamps,
      // Always present: the join is `required: true`, which is also what makes
      // it a second tenant check on the far side of a table with no businessId
      // of its own.
      service: z.object({
        id: uuid,
        name: z.string(),
        slug: z.string(),
        durationMinutes: z.number().int(),
        priceAmount: z.number().int(),
        currency: z.string(),
        isActive: z.boolean(),
      }),
    })
    .openapi({
      description:
        'One provider–service pairing, with the per-pairing overrides. A null override inherits ' +
        'the service’s own figure rather than meaning zero.',
    }),
);

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const memberSchema = named(
  'Member',
  z
    .object({
      id: uuid,
      status: z.enum(MEMBERSHIP_STATUSES),
      isOwner: z.boolean().openapi({
        description:
          'The account in `businesses.owner_user_id`. Nobody may edit or remove that membership, ' +
          'so a client should render it read-only rather than let the refusal arrive as a 409.',
      }),
      invitedAt: nullableInstant,
      joinedAt: nullableInstant,
      createdAt: instant,
      removedAt: nullableInstant.openapi({
        description: 'Set on a soft-deleted membership, which `includeRemoved` brings back.',
      }),
      user: z.object({
        id: uuid,
        email: z.string(),
        firstName: z.string(),
        lastName: z.string(),
        fullName: z.string(),
        avatarUrl: z.string().nullable(),
        status: z.enum(USER_STATUSES),
      }),
      role: roleRef,
      staffProfile: z
        .object({
          id: uuid,
          displayName: z.string(),
          isBookable: z.boolean(),
          isActive: z.boolean(),
        })
        .nullable()
        .openapi({ description: 'Null for a member who is not a bookable provider.' }),
    })
    .openapi({ description: 'Somebody who belongs to the workspace.' }),
);

export const memberPermissionsSchema = named(
  'MemberPermissions',
  z
    .object({
      membershipId: uuid,
      role: roleRef,
      rolePermissions: z.array(z.string()).openapi({
        description: 'What the role grants, before any per-member exception.',
      }),
      overrides: z.array(z.object({ permission: z.string(), effect: z.enum(PERMISSION_EFFECTS) })),
      effectivePermissions: z.array(z.string()).openapi({
        description: 'Role grants plus GRANTs minus DENYs — what the middleware will enforce.',
      }),
    })
    .openapi({
      description:
        'The three sets kept apart on purpose: "why can they not do this?" is answered by which ' +
        'of them the missing key is absent from.',
    }),
);

export const invitationSchema = named(
  'Invitation',
  z
    .object({
      membershipId: uuid,
      businessId: uuid,
      businessName: z.string(),
      businessSlug: z.string(),
      role: roleRef,
      invitedAt: nullableInstant,
      token: z.string().openapi({
        description:
          'Re-issued on every read, so a lost invitation email cannot strand somebody. Present ' +
          'the value to `POST /api/v1/members/accept`.',
      }),
    })
    .openapi({ description: 'An invitation addressed to the caller.' }),
);

export const acceptedInvitationSchema = named(
  'AcceptedInvitation',
  z
    .object({
      membershipId: uuid,
      businessId: uuid,
      businessName: z.string(),
      businessSlug: z.string(),
      role: roleRef,
      invitedAt: nullableInstant,
      token: z.string().openapi({
        description:
          'The token that was just spent. Echoed for correlation only: the membership has left ' +
          'INVITED, so replaying it finds nothing to accept.',
      }),
      status: z.enum(MEMBERSHIP_STATUSES),
    })
    .openapi({ description: 'The now-ACTIVE membership, with the workspace and role it grants.' }),
);

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export const serviceCategorySchema = named(
  'ServiceCategory',
  z
    .object({
      id: uuid,
      businessId: uuid,
      name: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      color: z.string().nullable(),
      sortOrder: z.number().int(),
      isActive: z.boolean(),
      ...timestamps,
      ...softDelete,
    })
    .openapi({ description: 'A grouping in the service catalogue.' }),
);

const serviceShape = {
  id: uuid,
  businessId: uuid,
  categoryId: uuid.nullable(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number().int(),
  // Null on every one of these means "inherit the workspace setting"; 0 means
  // "explicitly none". Collapsing the two is how a service ends up bookable
  // with no notice at all.
  preBufferMinutes: z.number().int().nullable(),
  postBufferMinutes: z.number().int().nullable(),
  priceAmount: z.number().int().openapi({
    description: 'In the smallest unit of `currency` — 1250 is ₹12.50. Never a decimal.',
  }),
  currency: z.string(),
  capacity: z.number().int().openapi({
    description: 'Above one makes this a group session: one appointment shared by many people.',
  }),
  minNoticeMinutes: z.number().int().nullable(),
  maxHorizonDays: z.number().int().nullable(),
  slotIntervalMinutes: z.number().int().nullable(),
  maxPerCustomerPerDay: z.number().int().nullable(),
  requiresApproval: z.boolean(),
  assignmentStrategy: z.enum(ASSIGNMENT_STRATEGIES),
  color: z.string().nullable(),
  isPublic: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  ...timestamps,
  ...softDelete,
};

export const serviceSchema = named(
  'Service',
  z
    .object({
      ...serviceShape,
      category: serviceCategoryRef.nullable().optional().openapi({
        description: 'Joined on the list and the read; absent from the create and amend responses.',
      }),
    })
    .openapi({ description: 'Something a workspace sells an appointment for.' }),
);

export const serviceDetailSchema = named(
  'ServiceDetail',
  z
    .object({
      ...serviceShape,
      category: serviceCategoryRef.nullable(),
      staff: z.array(
        z.object({
          ...staffCardRef.shape,
          ServiceStaff: z
            .object({
              durationMinutesOverride: z.number().int().nullable(),
              priceAmountOverride: z.number().int().nullable(),
              priority: z.number().int(),
              weight: z.number().int(),
              isActive: z.boolean(),
            })
            .openapi({
              description:
                'The join row, under the name Sequelize gives it. Carries what this pairing ' +
                'overrides for this one provider.',
            }),
        }),
      ),
      locations: z.array(locationCardRef).openapi({
        description: 'Where the service is offered. Empty means everywhere.',
      }),
    })
    .openapi({ description: 'One service with everything the catalogue screen needs.' }),
);

export const serviceStaffAssignmentSchema = named(
  'ServiceStaffAssignment',
  z
    .object({
      id: uuid,
      serviceId: uuid,
      staffProfileId: uuid,
      durationMinutesOverride: z.number().int().nullable(),
      priceAmountOverride: z.number().int().nullable(),
      priority: z.number().int(),
      weight: z.number().int(),
      isActive: z.boolean(),
      ...timestamps,
      staffProfile: staffCardRef,
    })
    .openapi({ description: 'One provider–service pairing, as the replace call returns it.' }),
);

export const serviceLocationAssignmentSchema = named(
  'ServiceLocationAssignment',
  z
    .object({
      id: uuid,
      serviceId: uuid,
      locationId: uuid,
      ...timestamps,
      location: locationCardRef,
    })
    .openapi({ description: 'One service–location pairing, as the replace call returns it.' }),
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const resourceSchema = named(
  'Resource',
  z
    .object({
      id: uuid,
      businessId: uuid,
      locationId: uuid.nullable().openapi({
        description:
          'Null means the resource is mobile and travels with the appointment, so a ' +
          'location-filtered search must not exclude it.',
      }),
      name: z.string(),
      slug: z.string(),
      type: z.enum(RESOURCE_TYPES),
      description: z.string().nullable(),
      capacity: z
        .number()
        .int()
        .openapi({
          description:
            'How many appointments may hold it at one instant. Above one, overlap alone is not a ' +
            'conflict.',
        }),
      color: z.string().nullable(),
      isActive: z.boolean(),
      ...timestamps,
      ...softDelete,
      location: locationCardRef.nullable().optional().openapi({
        description: 'Joined on the list and the read; absent from the create and amend responses.',
      }),
    })
    .openapi({ description: 'A room or a piece of equipment an appointment reserves.' }),
);

export const serviceResourceRequirementSchema = named(
  'ServiceResourceRequirement',
  z
    .object({
      id: uuid,
      serviceId: uuid,
      resourceId: uuid.nullable(),
      resourceType: z.enum(RESOURCE_TYPES).nullable(),
      quantity: z.number().int(),
      isRequired: z.boolean().openapi({
        description:
          'An optional requirement is reserved when one is free and skipped when none is, so a ' +
          'nicety never blocks a booking.',
      }),
      ...timestamps,
      resource: resourceRef.nullable().openapi({
        description: 'Null on a pooled row, which names a type rather than one specific resource.',
      }),
    })
    .openapi({ description: 'What a service reserves before it can be booked.' }),
);

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const customerShape = {
  id: uuid,
  businessId: uuid,
  publicId: z.string().openapi({
    description:
      'The `cus_…` handle customer-facing surfaces use; the uuid is never exposed there.',
  }),
  userId: uuid.nullable().openapi({
    description: 'Set once this record has been linked to a verified platform account.',
  }),
  firstName: z.string(),
  lastName: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  notes: z.string().nullable().openapi({
    description: 'Governed by `customers:notes:manage`, which writing this field requires.',
  }),
  tags: z.array(z.string()),
  preferredStaffProfileId: uuid.nullable(),
  preferredLocationId: uuid.nullable(),
  communicationPreferences: jsonObject.openapi({
    description: '`emailEnabled`, `smsEnabled`, `reminderOffsetsMinutes` and `marketingOptIn`.',
  }),
  status: z.enum(CUSTOMER_STATUSES).openapi({
    description:
      'Only ACTIVE may take a new appointment. BLOCKED is a deliberate ban and ARCHIVED a ' +
      'retired record; both keep their history readable.',
  }),
  // Maintained by the lifecycle, not by the client: the create and amend
  // bodies reject them outright.
  totalBookings: z.number().int(),
  completedCount: z.number().int(),
  cancelledCount: z.number().int(),
  noShowCount: z.number().int(),
  firstAppointmentAt: nullableInstant,
  lastAppointmentAt: nullableInstant,
  ...timestamps,
  ...softDelete,
};

export const customerSchema = named(
  'Customer',
  z.object(customerShape).openapi({ description: 'Somebody the workspace books.' }),
);

export const customerAppointmentSchema = named(
  'CustomerAppointment',
  z
    .object({
      id: uuid,
      publicId: z.string(),
      status: z.enum(APPOINTMENT_STATUSES),
      startsAt: instant,
      endsAt: instant,
      durationMinutes: z.number().int(),
      timezone: z.string(),
      priceAmount: z.number().int(),
      currency: z.string(),
      source: z.enum(APPOINTMENT_SOURCES),
      cancelledAt: nullableInstant,
      cancellationReason: z.string().nullable(),
      service: serviceRef.nullable(),
      staffProfile: staffRef.nullable(),
      location: locationRef.nullable(),
    })
    .openapi({
      description:
        "One row of a customer's booking history. Lighter than the diary shape: no notes, no " +
        'answers, no buffer arithmetic.',
    }),
);

export const customerDetailSchema = named(
  'CustomerDetail',
  z
    .object({
      customer: z.object({
        ...customerShape,
        preferredStaff: staffRef.nullable(),
        preferredLocation: locationRef.nullable(),
      }),
      recentAppointments: z.array(customerAppointmentSchema).openapi({
        description:
          'What the detail panel shows above the fold, newest start first. The full history is ' +
          'one request away at `/customers/{id}/appointments`.',
      }),
    })
    .openapi({ description: 'A customer with the last few bookings visible to the caller.' }),
);

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export const businessHoursSchema = named(
  'BusinessHours',
  z
    .object({
      id: uuid,
      businessId: uuid,
      locationId: uuid.nullable().openapi({
        description:
          'Null applies the window business-wide. Any row naming a location replaces the ' +
          'business-wide set for that branch entirely rather than adding to it.',
      }),
      dayOfWeek: z.number().int().min(0).max(6).openapi({ description: 'Sunday = 0.' }),
      startMinute: minuteOfDay,
      endMinute: minuteOfDay.openapi({
        description:
          'Minutes from local midnight, and may exceed 1440: 22:00–02:00 is stored as 1320–1560 ' +
          'and is one overnight window rather than two.',
      }),
      isActive: z.boolean(),
      ...timestamps,
    })
    .openapi({ description: 'One opening-hours window.' }),
);

export const staffAvailabilityRuleSchema = named(
  'StaffAvailabilityRule',
  z
    .object({
      id: uuid,
      businessId: uuid,
      staffProfileId: uuid,
      locationId: uuid.nullable().openapi({
        description: 'Null means the provider works this window at any location.',
      }),
      dayOfWeek: z.number().int().min(0).max(6),
      startMinute: minuteOfDay,
      endMinute: minuteOfDay,
      effectiveFrom: calendarDate.nullable(),
      effectiveTo: calendarDate.nullable().openapi({
        description:
          'The bounds that make a rota change come out right in hindsight: utilisation over a ' +
          'past period divides by the rules that were in force then, not by today’s.',
      }),
      isActive: z.boolean(),
      ...timestamps,
    })
    .openapi({ description: "One window of a provider's weekly rota." }),
);

export const availabilityOverrideSchema = named(
  'AvailabilityOverride',
  z
    .object({
      id: uuid,
      businessId: uuid,
      scope: z.enum(AVAILABILITY_OVERRIDE_SCOPES),
      staffProfileId: uuid.nullable(),
      locationId: uuid.nullable(),
      resourceId: uuid.nullable(),
      date: calendarDate,
      isAvailable: z.boolean().openapi({
        description: 'False removes time the recurring rules offer; true adds a window.',
      }),
      startMinute: minuteOfDay.nullable(),
      endMinute: minuteOfDay.nullable().openapi({
        description: 'Both null for a whole day; the CHECK constraint keeps them null together.',
      }),
      reason: z.enum(AVAILABILITY_OVERRIDE_REASONS).nullable(),
      note: z.string().nullable(),
      createdByUserId: uuid.nullable(),
      ...timestamps,
    })
    .openapi({ description: 'A one-off change to a single calendar day.' }),
);

export const holidaySchema = named(
  'Holiday',
  z
    .object({
      id: uuid,
      businessId: uuid,
      locationId: uuid.nullable().openapi({
        description: 'Null means every location observes it.',
      }),
      name: z.string(),
      date: calendarDate,
      isRecurringAnnually: z.boolean(),
      closesBusiness: z.boolean().openapi({
        description:
          'False labels the day for customers without removing any availability — a named day ' +
          'the workspace still trades on.',
      }),
      isActive: z.boolean(),
      ...timestamps,
    })
    .openapi({ description: 'A calendar day the workspace treats specially.' }),
);

export const blackoutPeriodSchema = named(
  'BlackoutPeriod',
  z
    .object({
      id: uuid,
      businessId: uuid,
      scope: z.enum(BLACKOUT_SCOPES),
      staffProfileId: uuid.nullable(),
      locationId: uuid.nullable(),
      resourceId: uuid.nullable(),
      startsAt: instant,
      endsAt: instant.openapi({
        description:
          'Half-open: a blackout ending exactly when a slot starts does not block it, matching ' +
          'the `[)` semantics of the range index so an in-memory check and a database check ' +
          'cannot disagree.',
      }),
      reason: z.enum(BLACKOUT_REASONS),
      note: z.string().nullable(),
      createdByUserId: uuid.nullable(),
      ...timestamps,
    })
    .openapi({
      description:
        'Time removed between two instants rather than across a calendar day — which is why, ' +
        'unlike an override, it needs no zone to be read in.',
    }),
);

// ---------------------------------------------------------------------------
// Booking links
// ---------------------------------------------------------------------------

const customQuestion = named(
  'CustomQuestion',
  customQuestionSchema.openapi({
    description:
      'One extra question a booking page asks. Registered from the same zod object the request ' +
      'side validates, so the published form and the accepted form cannot drift.',
  }),
);

const bookingLinkShape = {
  id: uuid,
  businessId: uuid,
  slug: z.string().openapi({ description: 'The public URL segment. Validated, never rewritten.' }),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(BOOKING_LINK_TYPES),
  // Exactly one of these three is set, decided by `type`; CATALOG sets none and
  // takes its offering from the services join instead.
  serviceId: uuid.nullable(),
  teamId: uuid.nullable(),
  staffProfileId: uuid.nullable(),
  locationId: uuid.nullable(),
  allowStaffSelection: z.boolean().openapi({
    description: 'When false the assignment engine picks the provider, not the customer.',
  }),
  requiresApproval: z.boolean(),
  customQuestions: z.array(jsonObject).openapi({
    description:
      'Stored as written. The validated shape is `CustomQuestion`; the column is JSONB, so the ' +
      'contract describes it as the bag it is rather than promising the row was never ' +
      'hand-edited.',
  }),
  branding: jsonObject,
  maxBookingsTotal: z.number().int().nullable().openapi({
    description: 'Null is uncapped; zero is rejected by the column’s CHECK and never arrives.',
  }),
  bookingCount: z.number().int(),
  expiresAt: nullableInstant,
  isActive: z.boolean(),
  ...timestamps,
  ...softDelete,
  publicUrl: z.string().openapi({ description: 'Where a customer actually goes.' }),
  isBookable: z.boolean().openapi({
    description:
      'Active, inside its window and under its cap — one flag rather than three, so a client ' +
      'cannot check the switch and forget the expiry.',
  }),
};

export const bookingLinkSchema = named(
  'BookingLink',
  z.object(bookingLinkShape).openapi({ description: 'A public booking page.' }),
);

export const bookingLinkDetailSchema = named(
  'BookingLinkDetail',
  z
    .object({
      ...bookingLinkShape,
      services: z
        .array(
          z.object({
            id: uuid,
            bookingLinkId: uuid,
            serviceId: uuid,
            sortOrder: z.number().int(),
            ...timestamps,
            service: z.object({
              id: uuid,
              name: z.string(),
              slug: z.string(),
              durationMinutes: z.number().int(),
              priceAmount: z.number().int(),
              currency: z.string(),
              capacity: z.number().int(),
              isPublic: z.boolean(),
              isActive: z.boolean(),
            }),
          }),
        )
        .openapi({
          description:
            'Populated for a CATALOG link. The array order is the order the public page lists them.',
        }),
    })
    .openapi({ description: 'A booking link with the services it offers.' }),
);

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

const appointmentShape = {
  id: uuid,
  publicId: z.string().openapi({
    description: 'The opaque `apt_…` handle. Behaves like a bearer token on the manage link.',
  }),
  businessId: uuid,
  serviceId: uuid,
  locationId: uuid.nullable(),
  staffProfileId: uuid.nullable(),
  teamId: uuid.nullable(),
  customerId: uuid.nullable(),
  bookingLinkId: uuid.nullable(),
  status: z.enum(APPOINTMENT_STATUSES),
  startsAt: instant,
  endsAt: instant.openapi({ description: 'What the customer sees.' }),
  bufferStartAt: instant,
  bufferEndAt: instant.openapi({
    description:
      'The true calendar footprint including preparation and cleanup. These are the values the ' +
      'database exclusion constraints compare, so two bookings can abut on `startsAt` and still ' +
      'collide here.',
  }),
  durationMinutes: z.number().int(),
  preBufferMinutes: z.number().int(),
  postBufferMinutes: z.number().int(),
  timezone: z.string().openapi({
    description: 'The zone the booking was made to be read in. The instants above stay UTC.',
  }),
  capacity: z.number().int(),
  bookedCount: z.number().int(),
  priceAmount: z.number().int(),
  currency: z.string(),
  source: z.enum(APPOINTMENT_SOURCES),
  title: z.string().nullable(),
  customerNotes: z.string().nullable(),
  internalNotes: z
    .string()
    .nullable()
    .openapi({
      description:
        'The private operator note. Governed by `appointments:notes:manage` and never sent to any ' +
        'customer-facing surface.',
    }),
  answers: jsonObject,
  requiresApproval: z.boolean(),
  confirmedAt: nullableInstant,
  checkedInAt: nullableInstant,
  startedAt: nullableInstant,
  completedAt: nullableInstant,
  cancelledAt: nullableInstant,
  noShowAt: nullableInstant,
  cancellationReason: z.string().nullable(),
  cancelledByType: z.enum(CANCELLED_BY_TYPES).nullable(),
  cancelledByUserId: uuid.nullable(),
  lateCancellation: z.boolean().openapi({
    description: 'True when the cancellation broke the workspace’s notice period.',
  }),
  rescheduledFromId: uuid.nullable(),
  rescheduleCount: z.number().int(),
  idempotencyKey: z.string().nullable(),
  createdByUserId: uuid.nullable(),
  ...timestamps,
};

export const appointmentSchema = named(
  'Appointment',
  z.object(appointmentShape).openapi({
    description:
      'The central scheduling record, as the lifecycle routes return it after a transition.',
  }),
);

export const appointmentListItemSchema = named(
  'AppointmentListItem',
  z
    .object({
      id: uuid,
      publicId: z.string(),
      status: z.enum(APPOINTMENT_STATUSES),
      startsAt: instant,
      endsAt: instant,
      durationMinutes: z.number().int(),
      timezone: z.string(),
      capacity: z.number().int(),
      bookedCount: z.number().int(),
      priceAmount: z.number().int(),
      currency: z.string(),
      source: z.enum(APPOINTMENT_SOURCES),
      title: z.string().nullable(),
      requiresApproval: z.boolean(),
      checkedInAt: nullableInstant,
      cancelledAt: nullableInstant,
      createdAt: instant,
      serviceId: uuid,
      staffProfileId: uuid.nullable(),
      locationId: uuid.nullable(),
      customerId: uuid.nullable(),
      service: diaryServiceRef.nullable(),
      staffProfile: staffRef.nullable(),
      location: locationRef.nullable(),
      customer: customerRef.nullable(),
    })
    .openapi({
      description:
        'A diary row: the appointment without its notes, answers and buffer arithmetic, plus the ' +
        'records needed to label it.',
    }),
);

export const calendarEventSchema = named(
  'CalendarEvent',
  z
    .object({
      id: uuid,
      publicId: z.string(),
      title: z
        .string()
        .nullable()
        .openapi({
          description:
            'What an operator renamed the booking to, falling back to the service name — the label ' +
            'every booking starts with.',
        }),
      status: z.enum(APPOINTMENT_STATUSES),
      startsAt: instant,
      endsAt: instant,
      timezone: z.string(),
      serviceId: uuid,
      serviceName: z.string().nullable(),
      color: z.string().nullable(),
      staffProfileId: uuid.nullable(),
      staffName: z.string().nullable(),
      locationId: uuid.nullable(),
      customerName: z.string().nullable().openapi({
        description: 'Given and family name joined, so a customer with no surname reads correctly.',
      }),
      capacity: z.number().int(),
      bookedCount: z.number().int(),
    })
    .openapi({ description: 'One block on a calendar grid: enough to draw and label it.' }),
);

export const appointmentParticipantSchema = named(
  'AppointmentParticipant',
  z
    .object({
      id: uuid,
      appointmentId: uuid,
      customerId: uuid,
      publicId: z.string().openapi({
        description:
          "The handle for this person's place, which is what matters on a group session.",
      }),
      role: z.enum(APPOINTMENT_PARTICIPANT_ROLES),
      status: z.enum(APPOINTMENT_PARTICIPANT_STATUSES),
      answers: jsonObject,
      joinedAt: instant,
      cancelledAt: nullableInstant,
      ...timestamps,
      customer: customerContactRef.nullable(),
    })
    .openapi({ description: 'One place on an appointment.' }),
);

export const appointmentStatusHistorySchema = named(
  'AppointmentStatusHistory',
  z
    .object({
      id: uuid,
      appointmentId: uuid,
      businessId: uuid,
      fromStatus: z.enum(APPOINTMENT_STATUSES).nullable().openapi({
        description: 'Null on the row that records the booking being created.',
      }),
      toStatus: z.enum(APPOINTMENT_STATUSES),
      actorType: z.enum(STATUS_HISTORY_ACTOR_TYPES).openapi({
        description:
          '"The owner cancelled this" is a materially different fact from "the customer did", ' +
          'which is why the actor is stamped on the row rather than inferred later.',
      }),
      actorUserId: uuid.nullable(),
      actorLabel: z
        .string()
        .nullable()
        .openapi({
          description:
            'For the rows no user id describes — a customer on a public manage link, or a named ' +
            'background job.',
        }),
      reason: z.string().nullable(),
      metadata: jsonObject,
      createdAt: instant,
    })
    .openapi({ description: 'One step through the appointment state machine.' }),
);

export const rescheduleHistorySchema = named(
  'RescheduleHistory',
  z
    .object({
      id: uuid,
      appointmentId: uuid,
      businessId: uuid,
      previousStartsAt: instant,
      previousEndsAt: instant,
      newStartsAt: instant,
      newEndsAt: instant,
      previousStaffProfileId: uuid.nullable(),
      newStaffProfileId: uuid.nullable(),
      previousLocationId: uuid.nullable(),
      newLocationId: uuid.nullable(),
      reason: z.string().nullable(),
      actorType: z.enum(RESCHEDULE_ACTOR_TYPES),
      actorUserId: uuid.nullable(),
      lateReschedule: z.boolean().openapi({
        description: 'True when the move broke the workspace’s reschedule deadline.',
      }),
      createdAt: instant,
    })
    .openapi({
      description:
        'One move. A provider swap and a time change are recorded on the same row, because they ' +
        'happened in the same act.',
    }),
);

export const appointmentDetailSchema = named(
  'AppointmentDetail',
  z
    .object({
      appointment: z.object({
        ...appointmentShape,
        service: diaryServiceRef.nullable(),
        staffProfile: staffRef.nullable(),
        location: locationRef.nullable(),
        customer: customerContactRef.nullable(),
      }),
      participants: z.array(appointmentParticipantSchema),
      statusHistory: z.array(appointmentStatusHistorySchema).openapi({
        description: 'Oldest first — the order the transitions happened in.',
      }),
      rescheduleHistory: z.array(rescheduleHistorySchema),
    })
    .openapi({
      description:
        'One appointment with the three trails behind it. They are read as separate queries ' +
        'rather than as nested joins, so participants × transitions × moves cannot multiply into ' +
        'a cartesian product.',
    }),
);

export const bookingResultSchema = named(
  'BookingResult',
  z
    .object({
      appointment: appointmentSchema,
      participant: z.object({
        id: uuid,
        publicId: z.string(),
        role: z.enum(APPOINTMENT_PARTICIPANT_ROLES),
        status: z.enum(APPOINTMENT_PARTICIPANT_STATUSES),
      }),
      customer: z.object({
        id: uuid,
        publicId: z.string(),
        firstName: z.string(),
        lastName: z.string().nullable(),
        email: z.string(),
      }),
    })
    .openapi({
      description:
        'What one booking created. The customer is echoed because the service may have matched ' +
        'an existing record on the submitted address rather than creating a new one.',
    }),
);

const effectivePolicySchema = named(
  'EffectivePolicy',
  z
    .object({
      durationMinutes: z.number().int(),
      preBufferMinutes: z.number().int(),
      postBufferMinutes: z.number().int(),
      slotIntervalMinutes: z.number().int(),
      minNoticeMinutes: z.number().int(),
      maxHorizonDays: z.number().int(),
      capacity: z.number().int(),
      requiresApproval: z.boolean(),
      cancellationDeadlineMinutes: z.number().int(),
      rescheduleDeadlineMinutes: z.number().int(),
      maxReschedulesPerAppointment: z.number().int(),
      allowCustomerCancel: z.boolean(),
      allowCustomerReschedule: z.boolean(),
      noShowGraceMinutes: z.number().int(),
      maxBookingsPerCustomerPerDay: z.number().int().nullable(),
      maxBookingsPerStaffPerDay: z.number().int().nullable(),
      priceAmount: z.number().int(),
      currency: z.string(),
    })
    .openapi({
      description:
        'The policy that actually applied to this search, already resolved: provider override, ' +
        'then service override, then workspace setting. A client showing a deadline should show ' +
        'this one rather than re-deriving it and getting a different answer.',
    }),
);

const availableSlotSchema = named(
  'AvailableSlot',
  z
    .object({
      startsAt: instant,
      endsAt: instant,
      staffProfileId: uuid,
      staffName: z.string(),
      locationId: uuid.nullable(),
      durationMinutes: z.number().int(),
      priceAmount: z.number().int(),
      currency: z.string(),
      remainingCapacity: z.number().int().optional().openapi({
        description: 'Group services only: places left on a session already partly filled.',
      }),
      joinsAppointmentId: uuid.optional().openapi({
        description: 'Present when taking this slot joins an existing group session.',
      }),
      matchScore: z.number().optional(),
      matchReason: z.string().optional().openapi({
        description: 'Both present only when the search was made with `explain=true`.',
      }),
    })
    .openapi({
      description:
        'One offered time, already attributed to the provider who would take it — which is what ' +
        'the booking call then requires.',
    }),
);

export const availabilitySearchSchema = named(
  'AvailabilitySearch',
  z
    .object({
      slots: z.array(availableSlotSchema),
      policy: effectivePolicySchema,
      timezone: z.string(),
      truncated: z.boolean().openapi({
        description:
          'True when the search hit its ceiling. Reported rather than silently cut, so a client ' +
          'narrows the range instead of drawing an incomplete week.',
      }),
      candidates: z
        .array(
          z.object({
            staffProfileId: uuid,
            displayName: z.string(),
            score: z.number(),
            reason: z.string(),
          }),
        )
        .optional()
        .openapi({
          description: 'Providers considered and their Smart Match scores, in explain mode.',
        }),
    })
    .openapi({ description: 'What could be booked, and why each time was offered by whom.' }),
);

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export const waitlistEntrySchema = named(
  'WaitlistEntry',
  z
    .object({
      id: uuid,
      publicId: z.string(),
      businessId: uuid,
      customerId: uuid,
      serviceId: uuid,
      staffProfileId: uuid.nullable(),
      locationId: uuid.nullable(),
      earliestDate: calendarDate,
      latestDate: calendarDate,
      earliestMinute: minuteOfDay,
      latestMinute: minuteOfDay.openapi({
        description: 'The daily window the customer will accept, read in `timezone`.',
      }),
      daysOfWeek: z.array(z.number().int()).openapi({
        description: 'Empty means no weekday restriction, not "no day works".',
      }),
      timezone: z.string(),
      status: z.enum(WAITLIST_STATUSES),
      priority: z.number().int(),
      notifyChannel: z.enum(WAITLIST_NOTIFY_CHANNELS),
      notifiedAt: nullableInstant,
      notificationCount: z.number().int(),
      holdExpiresAt: nullableInstant,
      heldSlotStartsAt: nullableInstant.openapi({
        description:
          'While the hold stands, the matcher skips that opening for everybody else — which is ' +
          'what stops two people being offered the same slot.',
      }),
      convertedAppointmentId: uuid.nullable(),
      expiresAt: nullableInstant,
      note: z.string().nullable(),
      ...timestamps,
      // Every read and every write answer through the same loader, so the joins
      // below are present on all of them.
      customer: customerContactRef.nullable(),
      service: serviceRef.nullable(),
      staffProfile: staffRef.nullable(),
      location: locationRef.nullable(),
      convertedAppointment: z
        .object({
          id: uuid,
          publicId: z.string(),
          status: z.enum(APPOINTMENT_STATUSES),
          startsAt: instant,
          endsAt: instant,
        })
        .nullable(),
    })
    .openapi({ description: 'Somebody waiting for a slot that does not exist yet.' }),
);

export const waitlistConversionSchema = named(
  'WaitlistConversion',
  z.object({ entry: waitlistEntrySchema, appointment: appointmentSchema }).openapi({
    description:
      'The entry in its final state and the booking it became. Both are returned because the ' +
      'entry is what the client was showing and the appointment is what it must show next.',
  }),
);

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const webhookEndpointShape = {
  id: uuid,
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(z.string()).openapi({
    description: '`*` subscribes to everything, including events added later.',
  }),
  isActive: z.boolean(),
  failureCount: z.number().int(),
  disabledAt: nullableInstant.openapi({
    description: 'Set when the delivery worker gave up after repeated failures.',
  }),
  lastSuccessAt: nullableInstant,
  lastFailureAt: nullableInstant,
  ...timestamps,
};

export const webhookEndpointSchema = named(
  'WebhookEndpoint',
  z.object(webhookEndpointShape).openapi({
    description:
      'A registered endpoint. Built by an allow-list rather than by removing a field, so the ' +
      'signing secret cannot reappear when a column is added.',
  }),
);

export const webhookDeliverySchema = named(
  'WebhookDelivery',
  z
    .object({
      id: uuid,
      endpointId: uuid,
      event: z.string(),
      eventId: z.string().openapi({
        description:
          'Stable across every endpoint notified of one occurrence, so a single event can be ' +
          'traced through several subscribers.',
      }),
      status: z.enum(WEBHOOK_DELIVERY_STATUSES),
      attemptCount: z.number().int(),
      maxAttempts: z.number().int(),
      responseStatus: z.number().int().nullable(),
      responseBody: z.string().nullable(),
      error: z.string().nullable().openapi({
        description: 'Set when the far end did not answer at all, rather than answering badly.',
      }),
      scheduledFor: instant,
      deliveredAt: nullableInstant,
      createdAt: instant,
      payload: jsonObject.openapi({
        description:
          'Carries opaque identifiers and never a customer name, address or phone number — so a ' +
          'mistyped URL leaks ids rather than a person.',
      }),
    })
    .openapi({ description: 'One attempt to deliver one event to one endpoint.' }),
);

export const webhookEndpointDetailSchema = named(
  'WebhookEndpointDetail',
  z
    .object({
      ...webhookEndpointShape,
      recentDeliveries: z.array(webhookDeliverySchema),
    })
    .openapi({ description: 'An endpoint with its latest attempts, for triage.' }),
);

export const createdWebhookEndpointSchema = named(
  'CreatedWebhookEndpoint',
  z
    .object({
      ...webhookEndpointShape,
      signingSecret: z.string().openapi({
        description:
          'The HMAC-SHA256 key. **This response is the only place it ever appears** — every read ' +
          'excludes it by the model’s default scope, so a client that does not store it now must ' +
          'delete the endpoint and register another.',
      }),
    })
    .openapi({
      description: 'The creation response, and the one shape carrying a signing secret.',
    }),
);

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export const analyticsOverviewSchema = named(
  'AnalyticsOverview',
  z
    .object({
      totalBookings: z.number().int(),
      confirmed: z.number().int(),
      completed: z.number().int(),
      cancelled: z.number().int(),
      noShows: z.number().int(),
      reschedules: z.number().int(),
      cancellationRate: z.number().openapi({ description: 'A share of the window, 0–1.' }),
      noShowRate: z.number(),
      newCustomers: z.number().int(),
      returningCustomers: z.number().int(),
      averageLeadTimeHours: z.number(),
      averageDurationMinutes: z.number(),
      revenueAmount: z.number().int().openapi({
        description: 'In the smallest unit of `currency`, from completed appointments.',
      }),
      currency: z.string(),
    })
    .openapi({ description: 'The headline counters for the requested window.' }),
);

export const analyticsTrendBucketSchema = named(
  'AnalyticsTrendBucket',
  z
    .object({
      date: calendarDate.openapi({
        description:
          'A calendar day on the workspace clock. It leaves the database as text and stays text: ' +
          'as a Date it would land on the previous day for any reader west of Greenwich.',
      }),
      bookings: z.number().int(),
      completed: z.number().int(),
      cancelled: z.number().int(),
      revenue: z.number().int(),
    })
    .openapi({ description: 'One day of the booking series.' }),
);

export const staffPerformanceSchema = named(
  'StaffPerformance',
  z
    .object({
      staffProfileId: uuid,
      displayName: z.string(),
      appointments: z.number().int(),
      completed: z.number().int(),
      noShows: z.number().int(),
      bookedMinutes: z.number().int(),
      workingMinutes: z
        .number()
        .int()
        .openapi({
          description:
            'The minutes the provider was genuinely available, taken from the rota rules in force ' +
            'on each day of the window rather than from today’s.',
        }),
      utilisationRate: z.number(),
      revenue: z.number().int(),
    })
    .openapi({ description: 'One provider over the window.' }),
);

export const servicePerformanceSchema = named(
  'ServicePerformance',
  z
    .object({
      serviceId: uuid,
      name: z.string(),
      bookings: z.number().int(),
      completed: z.number().int(),
      cancelled: z.number().int(),
      revenue: z.number().int(),
      averageDurationMinutes: z.number().openapi({
        description:
          'Measured from the appointments, not from the service’s configured length: what was ' +
          'delivered, not what was advertised.',
      }),
    })
    .openapi({ description: 'One service over the window.' }),
);

export const locationPerformanceSchema = named(
  'LocationPerformance',
  z
    .object({
      locationId: uuid,
      name: z.string(),
      bookings: z.number().int(),
      bookedMinutes: z.number().int(),
      openMinutes: z
        .number()
        .int()
        .openapi({
          description:
            'The hours the branch was actually open, less holidays, closures and blackouts. One ' +
            "provider's leave is deliberately not counted — it does not shut a site.",
        }),
      utilisationRate: z.number(),
    })
    .openapi({ description: 'One location over the window.' }),
);

export const peakTimeBucketSchema = named(
  'PeakTimeBucket',
  z
    .object({
      weekday: z.number().int().min(0).max(6).openapi({ description: 'Sunday = 0.' }),
      hour: z.number().int().min(0).max(23),
      bookings: z.number().int(),
    })
    .openapi({
      description:
        'One cell of the demand heatmap, bucketed on the workspace clock. Only observed cells ' +
        'are returned: an empty hour has nothing to report, and the full 168-cell grid would ' +
        'mean inventing the zeros.',
    }),
);

export const customerAnalyticsSchema = named(
  'CustomerAnalytics',
  z
    .object({
      activeCustomers: z.number().int(),
      repeatCustomers: z.number().int(),
      repeatRate: z.number().openapi({
        description:
          'Share of the window’s customers who have booked more than once *ever*. Measured over a ' +
          'lifetime rather than inside the window, or every short report would claim the business ' +
          'has no repeat custom at all.',
      }),
      newVsReturning: z.object({ new: z.number().int(), returning: z.number().int() }),
      topCustomers: z
        .array(
          z.object({
            customerId: uuid,
            publicId: z.string(),
            name: z.string(),
            appointments: z.number().int(),
            completed: z.number().int(),
            revenue: z.number().int(),
          }),
        )
        .openapi({
          description:
            'Ranked by attendance rather than by bookings made. A display name and a handle, and ' +
            'nothing else: contact details are governed by `customers:read`, which this endpoint ' +
            'does not require.',
        }),
    })
    .openapi({ description: 'Acquisition and loyalty over the window.' }),
);

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const appointmentReportRowSchema = named(
  'AppointmentReportRow',
  z
    .object({
      bookingReference: z.string(),
      status: z.enum(APPOINTMENT_STATUSES),
      startsAt: instant,
      endsAt: instant,
      startsAtLocal: z.string().openapi({
        description:
          'The same instant on the workspace clock — what an operator recognises. `timezone` says ' +
          'which clock, so the exported file is self-describing.',
        example: '2026-03-01 14:30:00',
      }),
      timezone: z.string(),
      durationMinutes: z.number().int(),
      // Flattened to display names rather than nested records: a report row is a
      // spreadsheet row, and the CSV export is generated from this same shape.
      service: z.string().nullable(),
      staff: z.string().nullable(),
      location: z.string().nullable(),
      customerName: z.string().nullable(),
      customerEmail: z.string().nullable(),
      priceAmount: z.number().int(),
      currency: z.string(),
      source: z.enum(APPOINTMENT_SOURCES),
      rescheduleCount: z.number().int(),
      createdAt: instant,
      completedAt: nullableInstant,
      cancelledAt: nullableInstant,
      noShowAt: nullableInstant,
      cancellationReason: z.string().nullable(),
    })
    .openapi({ description: 'One appointment as a report row — the JSON twin of a CSV line.' }),
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const auditEntryShape = {
  id: uuid,
  actorType: z.enum(AUDIT_ACTOR_TYPES),
  actorUserId: uuid.nullable(),
  actorCustomerId: uuid.nullable().openapi({
    description: 'Both actor ids null out when the account behind them is deleted.',
  }),
  actorLabel: z
    .string()
    .nullable()
    .openapi({
      description:
        'The snapshot taken when the entry was written, which is what survives that deletion. ' +
        'Nothing here is resolved through a join, so renaming an account later does not rewrite ' +
        'what the trail says happened.',
    }),
  action: z.string().openapi({ example: 'appointment.cancelled' }),
  entityType: z.string(),
  entityId: uuid.nullable(),
  requestId: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: instant,
  metadata: jsonObject.openapi({
    description: 'Non-sensitive context only: field names and ids, never a note or a credential.',
  }),
};

export const auditEntrySchema = named(
  'AuditEntry',
  z.object(auditEntryShape).openapi({
    description:
      'One entry as a tenant sees it. `businessId` is absent and its absence is the point: ' +
      "every row this surface can return is the caller's own.",
  }),
);

export const auditEntryDetailSchema = named(
  'AuditEntryDetail',
  z.object({ ...auditEntryShape, userAgent: z.string().nullable() }).openapi({
    description:
      'One entry, plus the user agent. Repetitive twenty rows at a time and exactly what an ' +
      'investigation into a single entry wants.',
  }),
);

// ---------------------------------------------------------------------------
// Platform admin
// ---------------------------------------------------------------------------

const adminWorkspaceSummaryShape = {
  id: uuid,
  name: z.string(),
  slug: z.string(),
  status: z.enum(BUSINESS_STATUSES),
  timezone: z.string(),
  currency: z.string(),
  industry: z.string().nullable(),
  owner: z
    .object({ id: uuid, email: z.string(), firstName: z.string(), lastName: z.string() })
    .nullable(),
  counts: z.object({
    members: z.number().int(),
    staff: z.number().int(),
    services: z.number().int(),
    locations: z.number().int(),
    appointments: z.number().int(),
    customers: z.number().int(),
  }),
  lastAppointmentAt: z.string().nullable(),
  createdAt: instant,
};

export const adminOverviewSchema = named(
  'AdminOverview',
  z
    .object({
      workspaces: z.object({
        total: z.number().int(),
        active: z.number().int(),
        suspended: z.number().int(),
        archived: z.number().int(),
        createdLast30Days: z.number().int(),
      }),
      users: z.object({
        total: z.number().int(),
        active: z.number().int(),
        invited: z.number().int(),
        suspended: z.number().int(),
        deactivated: z.number().int(),
        admins: z.number().int(),
        createdLast30Days: z.number().int(),
      }),
      appointments: z.object({
        total: z.number().int(),
        upcoming: z.number().int(),
        last30Days: z.number().int(),
        cancelledLast30Days: z.number().int(),
      }),
      customers: z.object({ total: z.number().int() }).openapi({
        description:
          'A total and nothing else. No part of this payload identifies a person a workspace books.',
      }),
      bookingsByDay: z.array(z.object({ date: calendarDate, count: z.number().int() })).openapi({
        description:
          'Exactly 14 UTC days ending today, zero-filled. Cut on when a booking was taken ' +
          'rather than when it falls due, so it answers "how much work came in".',
      }),
      topWorkspaces: z.array(
        z.object({
          businessId: uuid,
          name: z.string(),
          slug: z.string(),
          status: z.enum(BUSINESS_STATUSES),
          appointmentsLast30Days: z.number().int(),
        }),
      ),
      generatedAt: instant,
    })
    .openapi({ description: 'Platform-wide counters, across every tenant.' }),
);

export const adminWorkspaceSummarySchema = named(
  'AdminWorkspaceSummary',
  z.object(adminWorkspaceSummaryShape).openapi({
    description:
      'A workspace as the cross-tenant directory lists it: counts and the owning account, never ' +
      'any of the records inside it.',
  }),
);

export const adminWorkspaceDetailSchema = named(
  'AdminWorkspaceDetail',
  z
    .object({
      ...adminWorkspaceSummaryShape,
      legalName: z.string().nullable(),
      description: z.string().nullable(),
      websiteUrl: z.string().nullable(),
      supportEmail: z.string().nullable(),
      supportPhone: z.string().nullable(),
      locale: z.string(),
      members: z
        .array(
          z.object({
            membershipId: uuid,
            status: z.enum(MEMBERSHIP_STATUSES),
            roleKey: z.string(),
            roleName: z.string(),
            joinedAt: z.string().nullable(),
            user: z.object({
              id: uuid,
              email: z.string(),
              firstName: z.string(),
              lastName: z.string(),
              status: z.enum(USER_STATUSES),
              platformRole: z.enum(PLATFORM_ROLES),
            }),
          }),
        )
        .openapi({
          description:
            'Platform accounts, not customers: an operator can see who administers a clinic and ' +
            'never who it treats.',
        }),
      appointmentsByStatus: z.array(
        z.object({ status: z.enum(APPOINTMENT_STATUSES), count: z.number().int() }),
      ),
      recentActivity: z.array(
        z.object({
          id: uuid,
          action: z.string(),
          entityType: z.string(),
          actorLabel: z.string().nullable(),
          createdAt: instant,
        }),
      ),
    })
    .openapi({ description: 'One workspace as an operator administers it.' }),
);

const adminUserSummaryShape = {
  id: uuid,
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  fullName: z.string(),
  platformRole: z.enum(PLATFORM_ROLES),
  status: z.enum(USER_STATUSES),
  emailVerified: z.boolean(),
  lastLoginAt: z.string().nullable(),
  workspaceCount: z
    .number()
    .int()
    .openapi({
      description:
        'Ignores memberships in soft-deleted workspaces, so it always equals the length of the ' +
        'membership list the detail endpoint returns.',
    }),
  ownedWorkspaceCount: z.number().int(),
  createdAt: instant,
};

export const adminUserSummarySchema = named(
  'AdminUserSummary',
  z.object(adminUserSummaryShape).openapi({
    description:
      'A platform account — somebody who signs in, never a customer a workspace books. The two ' +
      'never meet on this surface.',
  }),
);

export const adminUserDetailSchema = named(
  'AdminUserDetail',
  z
    .object({
      ...adminUserSummaryShape,
      phone: z.string().nullable(),
      timezone: z.string(),
      locale: z.string(),
      lockedUntil: z.string().nullable(),
      failedLoginCount: z.number().int(),
      activeSessionCount: z
        .number()
        .int()
        .openapi({
          description:
            'The honest answer to "is this person still signed in somewhere" — what an operator ' +
            'needs both before suspending an account and immediately after.',
        }),
      memberships: z.array(
        z.object({
          membershipId: uuid,
          businessId: uuid,
          businessName: z.string(),
          businessSlug: z.string(),
          businessStatus: z.enum(BUSINESS_STATUSES),
          roleKey: z.string(),
          roleName: z.string(),
          status: z.enum(MEMBERSHIP_STATUSES),
          joinedAt: z.string().nullable(),
          isOwner: z.boolean(),
        }),
      ),
    })
    .openapi({ description: 'One platform account with its session state and memberships.' }),
);

export const adminAuditEntrySchema = named(
  'AdminAuditEntry',
  z
    .object({
      id: uuid,
      businessId: uuid.nullable().openapi({
        description: 'Null on the platform-level rows that belong to no tenant.',
      }),
      businessName: z.string().nullable(),
      actorType: z.enum(AUDIT_ACTOR_TYPES),
      actorLabel: z.string().nullable(),
      actorUserId: uuid.nullable(),
      action: z.string(),
      entityType: z.string(),
      entityId: uuid.nullable(),
      requestId: z.string().nullable(),
      ipAddress: z.string().nullable(),
      createdAt: instant,
      metadata: jsonObject,
    })
    .openapi({
      description:
        'An audit entry as the cross-tenant search returns it. Adds the workspace, which the ' +
        'tenant-scoped feed deliberately omits because there it could only ever be one value.',
    }),
);

export const adminHealthSchema = named(
  'AdminHealth',
  z
    .object({
      database: z.object({
        ok: z.boolean(),
        latencyMs: z.number().int(),
        error: z.string().nullable(),
      }),
      redis: z.object({
        ok: z.boolean(),
        latencyMs: z.number().int(),
        error: z.string().nullable(),
      }),
      outbox: z.object({
        pending: z.number().int(),
        processing: z.number().int(),
        sent: z.number().int(),
        failed: z.number().int(),
        cancelled: z.number().int(),
        dueNow: z.number().int(),
        oldestPendingAgeSeconds: z.number().int().nullable(),
      }),
      api: z.object({
        environment: z.string(),
        node: z.string(),
        uptimeSeconds: z.number().int(),
        apiVersion: z.literal('v1'),
      }),
      generatedAt: instant,
    })
    .openapi({
      description:
        'Operator-facing dependency status. Answers 200 even when something is down — a 503 would ' +
        'make the one page that could explain an outage disappear during one — so read the `ok` ' +
        'flags rather than the status code.',
    }),
);

// ---------------------------------------------------------------------------
// Customer portal
// ---------------------------------------------------------------------------

export const portalProfileSchema = named(
  'PortalProfile',
  z
    .object({
      user: userPublicSchema,
      workspaces: z
        .array(
          z.object({
            customerPublicId: z.string().openapi({
              description:
                'The `cus_…` handle of this person’s record there. A workspace is identified to a ' +
                'customer by their own record in it, never by an internal id.',
            }),
            business: z.object({
              name: z.string(),
              logoUrl: z.string().nullable(),
              timezone: z.string(),
              supportEmail: z.string().nullable(),
              supportPhone: z.string().nullable(),
            }),
            knownSince: instant,
            upcomingBookings: z.number().int(),
          }),
        )
        .openapi({ description: 'One entry per business that holds a record of this person.' }),
      upcomingBookings: z.number().int().openapi({
        description: 'A count across every workspace, not a list — the dashboard headline figure.',
      }),
    })
    .openapi({ description: 'The signed-in person and the businesses that know them.' }),
);

export const portalBookingSummarySchema = named(
  'PortalBookingSummary',
  z
    .object({
      publicId: z.string(),
      status: z.enum(APPOINTMENT_STATUSES),
      startsAt: instant,
      endsAt: instant,
      durationMinutes: z.number().int(),
      timezone: z.string(),
      priceAmount: z.number().int(),
      currency: z.string(),
      title: z.string().nullable(),
      cancelledAt: nullableInstant,
      cancellationReason: z.string().nullable(),
      rescheduleCount: z.number().int(),
      business: z.object({
        name: z.string(),
        logoUrl: z.string().nullable(),
        timezone: z.string(),
      }),
      service: z.object({ name: z.string(), durationMinutes: z.number().int() }).nullable(),
      staff: z.object({ displayName: z.string(), avatarUrl: z.string().nullable() }).nullable(),
      location: z
        .object({ name: z.string(), type: z.enum(LOCATION_TYPES), timezone: z.string() })
        .nullable(),
    })
    .openapi({
      description:
        'Enough to render a card and decide what to open. The staff-facing detail — internal ' +
        'notes and the rest — is deliberately absent, and the full record is one request away.',
    }),
);

export const portalPreferencesSchema = named(
  'PortalPreferences',
  z
    .object({
      preferences: z.object({
        emailEnabled: z.boolean(),
        smsEnabled: z.boolean(),
        marketingOptIn: z.boolean(),
        reminderOffsetsMinutes: z.array(z.number().int()).nullable().openapi({
          description: 'Null hands the schedule back to each workspace’s own reminder policy.',
        }),
      }),
      divergent: z.boolean().openapi({
        description:
          'True when the linked workspaces do not all hold the same answer — they can, because ' +
          'staff edit the same column from the address book. The reported value is then the ' +
          'conservative reading, and a client should say "varies" rather than present one ' +
          'workspace’s answer as universal.',
      }),
      workspaceCount: z.number().int(),
    })
    .openapi({
      description: 'Contact preferences folded across every workspace that knows the caller.',
    }),
);

// ---------------------------------------------------------------------------
// Public booking
// ---------------------------------------------------------------------------

const publicStaffSummary = named(
  'PublicStaff',
  z
    .object({ id: uuid, displayName: z.string(), avatarUrl: z.string().nullable() })
    .openapi({ description: 'A provider as a public page names them.' }),
);

const publicLocationSummary = named(
  'PublicLocation',
  z
    .object({
      id: uuid,
      name: z.string(),
      type: z.enum(LOCATION_TYPES),
      timezone: z.string(),
      address: z.string().nullable().openapi({
        description: 'A single line, or null for a location with nothing to show.',
      }),
    })
    .openapi({ description: 'A location as a public page names it.' }),
);

export const publicBookingConfigSchema = named(
  'PublicBookingConfig',
  z
    .object({
      link: z.object({
        slug: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        type: z.enum(BOOKING_LINK_TYPES),
        allowStaffSelection: z.boolean(),
        expiresAt: z
          .string()
          .nullable()
          .openapi({
            description:
              'An ISO string rather than a date-time object: this payload is cached in Redis, so a ' +
              'value that did not survive a JSON round trip would make a cache hit differ from a miss.',
          }),
        branding: jsonObject,
      }),
      business: z.object({
        name: z.string(),
        description: z.string().nullable(),
        logoUrl: z.string().nullable(),
        websiteUrl: z.string().nullable(),
        timezone: z.string(),
        currency: z.string(),
        locale: z.string(),
        supportEmail: z.string().nullable(),
        supportPhone: z.string().nullable(),
      }),
      services: z.array(
        z.object({
          id: uuid,
          name: z.string(),
          description: z.string().nullable(),
          durationMinutes: z.number().int(),
          priceAmount: z.number().int(),
          currency: z.string(),
          capacity: z.number().int(),
          requiresApproval: z.boolean(),
        }),
      ),
      locations: z.array(publicLocationSummary),
      staff: z.array(publicStaffSummary),
      questions: z.array(customQuestion),
      policy: z.object({
        timezone: z.string(),
        minNoticeMinutes: z.number().int(),
        maxHorizonDays: z.number().int(),
        cancellationDeadlineMinutes: z.number().int(),
        rescheduleDeadlineMinutes: z.number().int(),
        maxReschedulesPerAppointment: z.number().int(),
        allowCustomerCancel: z.boolean(),
        allowCustomerReschedule: z.boolean(),
        requiresApproval: z.boolean(),
      }),
    })
    .openapi({
      description:
        'Everything a public booking page needs to render itself. Deliberately absent: the ' +
        'workspace id, the link id and its booking counters — a customer needs none of them, and ' +
        'the counters would publish how a campaign is performing.',
    }),
);

export const publicAvailabilitySchema = named(
  'PublicAvailability',
  z
    .object({
      slots: z.array(
        z.object({
          startsAt: instant,
          endsAt: instant,
          staffProfileId: uuid,
          staffName: z.string(),
          locationId: uuid.nullable(),
          durationMinutes: z.number().int(),
          priceAmount: z.number().int(),
          currency: z.string(),
          remainingCapacity: z.number().int().optional(),
        }),
      ),
      timezone: z.string().openapi({
        description: 'The customer’s own zone, which bounded the search to their calendar days.',
      }),
      truncated: z.boolean(),
      service: z.object({
        durationMinutes: z.number().int(),
        priceAmount: z.number().int(),
        currency: z.string(),
        capacity: z.number().int(),
        minNoticeMinutes: z.number().int(),
        maxHorizonDays: z.number().int(),
        requiresApproval: z.boolean(),
      }),
    })
    .openapi({
      description:
        'What a customer may book. Narrower than the staff-side search: no Smart Match scores, and ' +
        'no policy beyond what the page itself has to show.',
    }),
);

export const publicAppointmentSchema = named(
  'PublicAppointment',
  z
    .object({
      publicId: z.string(),
      status: z.enum(APPOINTMENT_STATUSES),
      startsAt: instant,
      endsAt: instant,
      durationMinutes: z.number().int(),
      timezone: z.string(),
      priceAmount: z.number().int(),
      currency: z.string(),
      title: z.string().nullable(),
      customerNotes: z.string().nullable(),
      answers: jsonObject,
      requiresApproval: z.boolean(),
      confirmedAt: nullableInstant,
      cancelledAt: nullableInstant,
      cancellationReason: z.string().nullable(),
      rescheduleCount: z.number().int(),
      service: z
        .object({ id: uuid, name: z.string(), description: z.string().nullable() })
        .nullable(),
      staff: publicStaffSummary.nullable(),
      location: z
        .object({ ...publicLocationSummary.shape, virtualMeetingUrl: z.string().nullable() })
        .nullable(),
      business: z.object({
        name: z.string(),
        logoUrl: z.string().nullable(),
        timezone: z.string(),
        supportEmail: z.string().nullable(),
        supportPhone: z.string().nullable(),
      }),
      customer: z
        .object({ firstName: z.string(), lastName: z.string().nullable() })
        .nullable()
        .openapi({ description: 'The booker by name only — never their contact details.' }),
      policy: z.object({
        canCancel: z.boolean(),
        canReschedule: z.boolean(),
        cancellationDeadlineMinutes: z.number().int(),
        rescheduleDeadlineMinutes: z.number().int(),
        remainingReschedules: z.number().int(),
      }),
      manageUrl: z.string(),
    })
    .openapi({
      description:
        'The customer-facing view of one booking, and the single projection behind both the ' +
        'anonymous manage link and the signed-in portal — so the two cannot drift on what a ' +
        'customer may see. `policy` is already evaluated against the clock, so a client shows the ' +
        'buttons it names rather than re-deriving the deadline.',
    }),
);

export const publicBookingConfirmationSchema = named(
  'PublicBookingConfirmation',
  z
    .object({
      appointment: z.object({
        publicId: z.string(),
        status: z.enum(APPOINTMENT_STATUSES),
        startsAt: instant,
        endsAt: instant,
        durationMinutes: z.number().int(),
        timezone: z.string(),
        priceAmount: z.number().int(),
        currency: z.string(),
        title: z.string().nullable(),
        requiresApproval: z.boolean(),
        serviceId: uuid,
        staffProfileId: uuid.nullable(),
        locationId: uuid.nullable(),
      }),
      participantPublicId: z.string().openapi({
        description:
          'The handle for this person’s place, which is what matters on a group session.',
      }),
      manageUrl: z.string(),
      replayed: z.boolean().openapi({
        description:
          'True when an idempotency key matched an earlier request, meaning this call created ' +
          'nothing and the booking described is the original.',
      }),
    })
    .openapi({ description: 'What a customer gets back from booking.' }),
);

// ---------------------------------------------------------------------------
// Notification templates
//
// Transcribed from `TemplateView` and `TemplatePreview` in
// `modules/notifications/templates.service.ts`. `key` and `channel` come from
// the model's own constant lists, per rule 2 — a seventeenth template key is
// then a compile error here rather than a contract that quietly omits it.
// ---------------------------------------------------------------------------

export const notificationTemplateSchema = named(
  'NotificationTemplate',
  z
    .object({
      key: z.enum(NOTIFICATION_TEMPLATE_KEYS),
      channel: z.enum(NOTIFICATION_TEMPLATE_CHANNELS),
      locale: z.string(),
      subject: z.string().nullable().openapi({
        description:
          'What will actually be sent. Null on SMS and in-app messages, which have no subject.',
      }),
      bodyText: z.string().openapi({ description: 'What will actually be sent.' }),
      source: z.enum(['WORKSPACE', 'BUILT_IN']).openapi({
        description:
          'Where the copy above comes from. `BUILT_IN` messages change when MeetFlow improves ' +
          'them; `WORKSPACE` messages do not, which is the distinction the screen exists to show.',
      }),
      isActive: z.boolean().openapi({
        description:
          'Whether the workspace override is live. False with no override at all, and false for ' +
          'an override deliberately switched off — a parked draft, where `source` stays BUILT_IN.',
      }),
      defaultSubject: z.string().nullable().openapi({
        description: 'MeetFlow’s own copy, always present, so the editor can offer to restore it.',
      }),
      defaultBodyText: z.string().nullable(),
      placeholders: z.array(z.object({ name: z.string(), description: z.string() })).openapi({
        description:
          'The names this message can fill, with one line of help each. Writing anything else ' +
          'is refused on save rather than rendered as empty text.',
      }),
      updatedAt: instant.nullable().openapi({
        description: 'When the override was last written. Null when there is no override.',
      }),
    })
    .openapi({ description: 'One message, with what is being sent and what could be.' }),
);

export const notificationTemplatePreviewSchema = named(
  'NotificationTemplatePreview',
  z
    .object({
      subject: z.string().nullable(),
      bodyText: z.string(),
      bodyHtml: z
        .string()
        .nullable()
        .openapi({
          description:
            'The generated HTML part. Null for SMS and in-app, which have none — previewing one ' +
            'would show the operator something the recipient never sees.',
        }),
      placeholdersUsed: z.array(z.string()),
    })
    .openapi({ description: 'A draft rendered against sample data, before it is saved.' }),
);
