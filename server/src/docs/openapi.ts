/**
 * The MeetFlow API contract, generated from the implementation.
 *
 * Every request schema referenced here is imported from the module's own
 * `*.validation.ts` — the exact object `validate()` runs at runtime. Nothing is
 * re-declared, so the published contract cannot drift from what the server
 * actually accepts: change a zod schema and this document changes with it.
 *
 * Response payloads cannot be derived the same way, because MeetFlow shapes
 * them in its controllers and Sequelize models rather than in a schema. They
 * were once left undescribed for that reason — a zod mirror of them is a second
 * definition, which is what this file exists to avoid — and the cost of that
 * turned out to be higher than the duplication it prevented: with no payload
 * schemas the contract could generate no client, so the client wrote its own
 * copy and drifted from the server twice. `docs/responses.ts` now holds those
 * schemas, transcribed from the services that build the payloads and read as
 * documentation rather than run as validation; its header states the rules that
 * keep the transcription honest, including the one that matters most, which is
 * that an unconfirmed payload is left undescribed rather than guessed at.
 *
 * So an operation answers in one of four ways: the success envelope closed over
 * a named payload, 204 with no body, `text/csv` on the two export routes, and
 * `{ error }` for every failure. Every operation that returns a JSON body names
 * its payload — the untyped-envelope fallback in `ok()`, `page()` and
 * `created()` is kept for a payload that cannot be confirmed from the service,
 * and is currently used by none of them.
 *
 * Route coverage is transcribed from `routes/index.ts` and each module's
 * `*.routes.ts`; the paths below carry the same mount prefixes the router
 * applies, including `/api/v1` and the `/public` sub-surface.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type ResponseConfig,
  type RouteConfig,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { ErrorCode } from '../utils/errors';

import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '../modules/auth/auth.validation';
import {
  createBusinessSchema,
  slugAvailabilitySchema,
  updateBusinessSchema,
  updateSettingsSchema,
} from '../modules/businesses/business.validation';
import {
  createLocationSchema,
  listLocationsQuerySchema,
  locationIdParamSchema,
  updateLocationSchema,
} from '../modules/locations/locations.validation';
import {
  addTeamMemberSchema,
  createTeamSchema,
  listTeamsQuerySchema,
  teamIdParamsSchema,
  teamMemberParamsSchema,
  updateTeamMemberSchema,
  updateTeamSchema,
} from '../modules/teams/teams.validation';
import {
  createStaffSchema,
  listStaffQuerySchema,
  replaceStaffServicesSchema,
  staffIdParamsSchema,
  updateStaffSchema,
} from '../modules/staff/staff.validation';
import {
  acceptInvitationSchema,
  inviteMemberSchema,
  listMembersQuerySchema,
  memberIdParamsSchema,
  replaceMemberPermissionsSchema,
  updateMemberSchema,
} from '../modules/members/members.validation';
import {
  categoryIdParamsSchema,
  createCategorySchema,
  createServiceSchema,
  listCategoriesQuerySchema,
  listServicesQuerySchema,
  replaceServiceLocationsSchema,
  replaceServiceStaffSchema,
  serviceIdParamsSchema,
  updateCategorySchema,
  updateServiceSchema,
} from '../modules/services/services.validation';
import {
  createResourceSchema,
  listResourcesQuerySchema,
  replaceServiceRequirementsSchema,
  resourceIdParamsSchema,
  serviceIdParamsSchema as resourceServiceIdParamsSchema,
  updateResourceSchema,
} from '../modules/resources/resources.validation';
import {
  createCustomerSchema,
  customerIdParamSchema,
  listCustomerAppointmentsQuerySchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from '../modules/customers/customers.validation';
import {
  createBlackoutSchema,
  createHolidaySchema,
  createOverrideSchema,
  idParamsSchema as availabilityIdParamsSchema,
  listBlackoutsQuerySchema,
  listBusinessHoursQuerySchema,
  listHolidaysQuerySchema,
  listOverridesQuerySchema,
  listStaffRulesQuerySchema,
  replaceBusinessHoursSchema,
  replaceStaffRulesSchema,
  staffProfileIdParamsSchema,
} from '../modules/availability/availability.validation';
import {
  bookingLinkIdParamsSchema,
  createBookingLinkSchema,
  listBookingLinksQuerySchema,
  replaceBookingLinkServicesSchema,
  updateBookingLinkSchema,
} from '../modules/bookingLinks/bookingLinks.validation';
import {
  appointmentIdParamSchema,
  availabilitySlotsQuerySchema,
  calendarQuerySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  emptyBodySchema,
  listAppointmentsQuerySchema,
  rescheduleAppointmentSchema,
  updateAppointmentSchema,
} from '../modules/appointments/appointments.validation';
import {
  convertWaitlistEntrySchema,
  createWaitlistEntrySchema,
  listWaitlistQuerySchema,
  notifyWaitlistEntrySchema,
  updateWaitlistEntrySchema,
  waitlistIdParamSchema,
} from '../modules/waitlist/waitlist.validation';
import {
  createWebhookSchema,
  listDeliveriesQuerySchema,
  listWebhooksQuerySchema,
  updateWebhookSchema,
  webhookIdParamsSchema,
} from '../modules/webhooks/webhooks.validation';
import { analyticsRangeQuerySchema } from '../modules/analytics/analytics.validation';
import {
  appointmentExportQuerySchema,
  appointmentReportQuerySchema,
} from '../modules/analytics/reports.validation';
import {
  auditEntryIdParamsSchema,
  exportAuditEntriesQuerySchema,
  listAuditEntriesQuerySchema,
} from '../modules/audit/audit.validation';
import {
  listAuditLogsQuerySchema,
  listUsersQuerySchema,
  listWorkspacesQuerySchema,
  updatePlatformRoleSchema,
  updateUserStatusSchema,
  updateWorkspaceStatusSchema,
  userIdParamsSchema,
  workspaceIdParamsSchema,
} from '../modules/admin/admin.validation';
import {
  appointmentPublicIdParamsSchema,
  bookingLinkSlugParamsSchema,
  cancelPublicAppointmentSchema,
  createPublicBookingSchema,
  publicAvailabilityQuerySchema,
  reschedulePublicAppointmentSchema,
} from '../modules/publicBooking/publicBooking.validation';
import {
  bookingPublicIdParamsSchema,
  cancelBookingSchema,
  listBookingsQuerySchema,
  rescheduleBookingSchema,
  updatePreferencesSchema,
} from '../modules/customers/portal.validation';

// Response payloads. Transcribed from the services that build them rather than
// imported from a runtime schema, because there is no runtime schema to import
// — the reasoning, and the rules that keep the transcription honest, are in
// that file's header.
import * as R from './responses';

// `.openapi()` is added to every zod schema by this call, including the ones the
// modules above already constructed: it patches the shared prototype, so the
// extension applies retroactively and no validation schema needs to know this
// file exists.
extendZodWithOpenApi(z);

/** The document this module builds. Named so no openapi3-ts import is needed. */
export type OpenApiDocument = ReturnType<OpenApiGeneratorV3['generateDocument']>;

export const registry = new OpenAPIRegistry();

// ---------------------------------------------------------------------------
// Tags — one per module, mirroring the router mounts
// ---------------------------------------------------------------------------

const TAGS = {
  health: 'Health',
  auth: 'Auth',
  workspace: 'Workspace',
  locations: 'Locations',
  teams: 'Teams',
  staff: 'Staff',
  members: 'Members',
  services: 'Services',
  resources: 'Resources',
  customers: 'Customers',
  availability: 'Availability',
  bookingLinks: 'Booking Links',
  appointments: 'Appointments',
  waitlist: 'Waitlist',
  webhooks: 'Webhooks',
  analytics: 'Analytics',
  reports: 'Reports',
  audit: 'Audit',
  admin: 'Platform Admin',
  customerPortal: 'Customer Portal',
  publicBooking: 'Public Booking',
} as const;

const TAG_DESCRIPTIONS: Array<{ name: string; description: string }> = [
  {
    name: TAGS.health,
    description:
      'Liveness, readiness and build metadata. Mounted outside /api/v1 so probes never sit ' +
      'behind versioning or authentication.',
  },
  {
    name: TAGS.auth,
    description:
      'Registration, sessions and password lifecycle. Unauthenticated except where stated; ' +
      'every credential-handling route sits behind a bucket keyed on IP and submitted email.',
  },
  {
    name: TAGS.workspace,
    description:
      'Creating a workspace, and reading or amending the one the caller is acting in — ' +
      'including its booking policy, members and roles.',
  },
  { name: TAGS.locations, description: 'The sites appointments can be held at.' },
  { name: TAGS.teams, description: 'Groups of staff that share an assignment strategy.' },
  { name: TAGS.staff, description: 'Bookable provider profiles and the services they deliver.' },
  {
    name: TAGS.members,
    description:
      'Who belongs to the workspace, what each of them may do, and how somebody joins or ' +
      'leaves. This is the surface that hands out authority, so what it guarantees is what ' +
      'cannot happen: the last account able to manage roles cannot be demoted, suspended or ' +
      'removed, nobody may edit their own membership or the owners, and a member still ' +
      'holding upcoming appointments cannot be removed out from under them. A role change ' +
      'lands on the next request the affected person makes — effective permissions are read ' +
      'from the membership on every call rather than baked into a token — so a mistake is ' +
      'undone as fast as it was made, and revoking access does not wait for a session to ' +
      'expire. Two paths here are authenticated but not tenant-scoped, and say so.',
  },
  { name: TAGS.services, description: 'The service catalogue and its categories.' },
  {
    name: TAGS.resources,
    description: 'Rooms and equipment, and the resources each service reserves.',
  },
  { name: TAGS.customers, description: 'The workspace address book and its booking history.' },
  {
    name: TAGS.availability,
    description:
      'The rota: opening hours, per-staff weekly rules, one-off overrides, holidays and ' +
      'blackout periods.',
  },
  { name: TAGS.bookingLinks, description: 'The public booking pages a workspace publishes.' },
  {
    name: TAGS.appointments,
    description:
      'The diary. Booking, amending, and the status lifecycle — approve, reject, check in, ' +
      'complete and no-show.',
  },
  {
    name: TAGS.waitlist,
    description: 'Customers waiting for a slot, and converting them into one.',
  },
  {
    name: TAGS.webhooks,
    description:
      'Outbound event delivery: where a workspace wants to be told when its diary changes. ' +
      "Registering an endpoint points a workspace's event stream at a server of the " +
      "registrant's choosing, which is a materially larger act than reading delivery " +
      'history, so the built-in roles grant the two separately and only an owner may ' +
      'register one. The ' +
      'signing secret is returned exactly once, in the creation response, and is readable ' +
      'nowhere else in the API — losing it means replacing the endpoint. Payloads carry ' +
      'opaque identifiers and never a customer name, address or phone number, so a mistyped ' +
      'URL leaks ids rather than a person.',
  },
  { name: TAGS.analytics, description: 'Aggregations over the appointment table.' },
  {
    name: TAGS.reports,
    description: 'The same rows listed rather than aggregated, plus CSV export.',
  },
  {
    name: TAGS.audit,
    description:
      "The workspace's own copy of the trail every mutating service writes to. Read-only, " +
      'and that is the property worth having: nothing on this surface can amend or delete an ' +
      'entry, so the record of what happened cannot be edited by whoever it happened to. ' +
      'Scoped by the query itself rather than by a filter applied afterwards — another ' +
      "tenant's entries and platform-level entries cannot be named, only missed. Entries " +
      'carry the actor as a snapshot taken at the time, so a person renaming themselves ' +
      'later does not rewrite history.',
  },
  {
    name: TAGS.admin,
    description:
      'Operating the platform itself, and the only endpoints that read across tenants. They ' +
      'require `platformRole = ADMIN` and are not tenant-scoped — X-Business-Id plays no part ' +
      'here, because an operator holds no membership in the workspaces they administer. What ' +
      'they expose is workspaces, platform accounts and counts; never customer names, contact ' +
      'details, appointment contents or notes. Running the platform is no reason to read a ' +
      "clinic's patient list, and the shape of these responses is what enforces that.",
  },
  {
    name: TAGS.customerPortal,
    description:
      'A customer reading and changing their own bookings, across every workspace that has a ' +
      'record of them. **Authenticated but not tenant-scoped** — X-Business-Id plays no part ' +
      'here, because a customer holds no membership to select among; they are a person who ' +
      "appears in one or more workspaces' address books. Every response is built from the " +
      'customer records tied to the signed-in account, so this surface returns only rows ' +
      'belonging to the person asking, and a booking reference belonging to somebody else is ' +
      'indistinguishable from one that never existed: both answer 404. Cancelling or ' +
      'rescheduling runs the workspace booking policy exactly as the anonymous manage link ' +
      'does, so signing in is never a way round a notice period — including for somebody who ' +
      'happens to be a member of that workspace as well.',
  },
  {
    name: TAGS.publicBooking,
    description:
      'The unauthenticated booking surface. Tenant context comes from the booking-link slug ' +
      'in the path; existing bookings are addressed only by their opaque apt_ handle.',
  },
];

// ---------------------------------------------------------------------------
// Security and shared headers
// ---------------------------------------------------------------------------

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'The short-lived access token returned by POST /api/v1/auth/login, sent as ' +
    '`Authorization: Bearer <token>`. Refresh tokens are never accepted here — they are ' +
    'exchanged at POST /api/v1/auth/refresh, and browser clients hold them in an httpOnly cookie.',
});

const businessIdHeader = registry.registerParameter(
  'XBusinessId',
  z
    .string()
    .uuid()
    .optional()
    .openapi({
      param: {
        name: 'X-Business-Id',
        in: 'header',
        required: false,
        description:
          "Selects which of the caller's own workspaces the request acts in. It is never a " +
          'tenant assertion: the value is only used to pick among ACTIVE memberships the ' +
          'authenticated user already holds, and an id they do not belong to answers 404. ' +
          'Optional when the user belongs to exactly one workspace; required — with a 403 ' +
          'asking them to choose — when they belong to several.',
      },
      example: '9b2f1c34-5d6e-4f70-8a91-2c3d4e5f6a7b',
    }),
);

const idempotencyHeader = registry.registerParameter(
  'XIdempotencyKey',
  z
    .string()
    .min(1)
    .max(255)
    .optional()
    .openapi({
      param: {
        name: 'X-Idempotency-Key',
        in: 'header',
        required: false,
        description:
          'A client-chosen key that makes a booking request safe to retry. A repeat carrying ' +
          'the same key answers with the original booking instead of creating a second one — ' +
          'the management route reports this as `meta.replayed`, the public route by answering ' +
          '200 rather than 201.',
      },
      example: 'booking-2f7c1e90-1a2b-4c3d-9e8f-0a1b2c3d4e5f',
    }),
);

// ---------------------------------------------------------------------------
// Envelopes
//
// Every endpoint answers in one of exactly two shapes (utils/http.ts and
// middleware/errorHandler.ts), which is what lets a client write one response
// handler instead of one per route.
// ---------------------------------------------------------------------------

const errorDetailSchema = registry.register(
  'ErrorDetail',
  z
    .object({
      field: z
        .string()
        .optional()
        .openapi({
          description:
            'Dotted path of the offending field, e.g. `customer.email` or `hours.3.endTime`. ' +
            'Absent when the problem is not attributable to one field.',
          example: 'customer.email',
        }),
      message: z.string().openapi({ example: 'Enter a valid email address.' }),
      code: z
        .string()
        .optional()
        .openapi({ description: 'The zod issue code, when the detail came from validation.' }),
    })
    .passthrough()
    .openapi({
      description: 'One structured, non-sensitive reason a request was rejected.',
    }),
);

const errorEnvelopeSchema = registry.register(
  'ErrorEnvelope',
  z
    .object({
      error: z.object({
        code: z.nativeEnum(ErrorCode).openapi({
          description:
            'A stable machine code. Additive changes only, so a client may switch on it ' +
            'safely; the accompanying message is for humans and may be reworded.',
          example: ErrorCode.VALIDATION_FAILED,
        }),
        message: z.string().openapi({
          description:
            'Human-readable explanation. A 5xx in production carries a fixed generic message — ' +
            'the real one stays in the server log, correlated by requestId.',
        }),
        details: z
          .array(errorDetailSchema)
          .optional()
          .openapi({ description: 'Present when the failure decomposes into per-field reasons.' }),
        requestId: z.string().openapi({
          description:
            'Echoed in the X-Request-Id response header. Quote it when reporting a fault: it ' +
            'is the only handle that reaches the server-side detail.',
        }),
        meta: z
          .record(z.unknown())
          .optional()
          .openapi({
            description:
              'Non-sensitive context for the failure — `retryAfterSeconds` on a 429, the ' +
              '`required` permission keys on a 403, `from`/`to` on an illegal transition.',
          }),
      }),
    })
    .openapi({ description: 'The shape of every failed response.' }),
);

const pageMetaSchema = registry.register(
  'PageMeta',
  z
    .object({
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
      totalItems: z.number().int().min(0),
      totalPages: z.number().int().min(0),
      hasNextPage: z.boolean(),
    })
    .passthrough()
    .openapi({
      description:
        'Pagination counters attached to every list response. Individual endpoints may add ' +
        'further keys alongside these.',
    }),
);

const successEnvelopeSchema = registry.register(
  'SuccessEnvelope',
  z
    .object({
      data: z.unknown().openapi({
        description: 'The endpoint payload. Each operation names the schema it holds.',
      }),
      meta: z.record(z.unknown()).optional().openapi({
        description: 'Present when the endpoint has something to say about the payload.',
      }),
    })
    .openapi({
      description:
        'The generic shape of every successful response that has a body. Operations narrow ' +
        '`data` to their own payload rather than referencing this, so nothing points at it — it ' +
        'is here to state the contract one place, and it is what an operation whose payload is ' +
        'not yet modelled would fall back to.',
      required: ['data'],
    }),
);

const paginatedEnvelopeSchema = registry.register(
  'PaginatedEnvelope',
  z
    .object({
      data: z.array(z.unknown()).openapi({ description: 'One page of rows.' }),
      meta: pageMetaSchema,
    })
    .openapi({
      description:
        'The same envelope as a list endpoint fills it in, with the counters always present. ' +
        'Referenced by nothing, and for the same reason as SuccessEnvelope.',
    }),
);

const healthStatusSchema = registry.register(
  'HealthStatus',
  z
    .object({
      status: z.literal('ok'),
      service: z.string().openapi({ example: 'meetflow-api' }),
      env: z.string().openapi({ example: 'development' }),
      uptimeSeconds: z.number().int().min(0),
      timestamp: z.string().datetime(),
    })
    .openapi({
      description:
        'Answered without touching any dependency, so a database blip cannot make an ' +
        'orchestrator kill healthy pods.',
    }),
);

const dependencyCheckSchema = registry.register(
  'DependencyCheck',
  z
    .object({
      ok: z.boolean(),
      latencyMs: z.number().int().min(0),
      error: z.string().optional().openapi({ description: 'Present only when `ok` is false.' }),
      required: z.boolean().openapi({
        description: 'Whether losing this dependency makes the instance unable to serve traffic.',
      }),
    })
    .openapi({ description: 'The result of one readiness probe.' }),
);

const readinessSchema = registry.register(
  'ReadinessStatus',
  z
    .object({
      status: z.enum(['ready', 'degraded', 'unavailable']).openapi({
        description:
          '`degraded` means Redis is down but PostgreSQL is up — caching, rate limiting and ' +
          'queues all fall back, so the instance keeps taking traffic and still answers 200.',
      }),
      checks: z.object({ database: dependencyCheckSchema, redis: dependencyCheckSchema }),
      timestamp: z.string().datetime(),
    })
    .openapi({ description: 'Whether this instance should receive traffic.' }),
);

// ---------------------------------------------------------------------------
// Payload components
//
// Registered here rather than left to be discovered through the operations
// below, and *before* the first of them: the generator caches a component the
// first time it meets one, so the first use wins. `responses.ts` explains what
// that costs when the first use happens to be a nullable field.
// ---------------------------------------------------------------------------

for (const definition of R.RESPONSE_SCHEMAS) {
  registry.register(definition.name, definition.schema);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(description: string, schema: z.ZodTypeAny): ResponseConfig {
  return { description, content: { 'application/json': { schema } } };
}

/**
 * The success envelope closed over one payload.
 *
 * Built inline per operation rather than registered as a component of its own:
 * the envelope is the same two keys everywhere and it is `data` that differs,
 * so a named `AppointmentEnvelope`, `ServiceEnvelope` and so on for every
 * payload would double the component list to say nothing. `data` still
 * resolves to a `$ref`, which is the part a client generator reads.
 */
function envelope(payload: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({
    data: payload,
    meta: z.record(z.unknown()).optional(),
  });
}

function pagedEnvelope(item: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({ data: z.array(item), meta: pageMetaSchema });
}

/**
 * A 200 with a body.
 *
 * `payload` is what makes the operation say what it returns, and the
 * description then explains that payload instead of enumerating its fields. It
 * is optional on purpose: an operation whose payload could not be read off the
 * service keeps the untyped envelope rather than acquiring a guessed schema
 * that a generated client would then trust. See the rules in `responses.ts`.
 */
function ok(description: string, payload?: z.ZodTypeAny): Record<string, ResponseConfig> {
  return {
    '200': jsonResponse(description, payload ? envelope(payload) : successEnvelopeSchema),
  };
}

/** A page of rows. `item` types one row; the meta counters are always the same. */
function page(description: string, item?: z.ZodTypeAny): Record<string, ResponseConfig> {
  return {
    '200': jsonResponse(description, item ? pagedEnvelope(item) : paginatedEnvelopeSchema),
  };
}

function created(description: string, payload?: z.ZodTypeAny): Record<string, ResponseConfig> {
  return {
    '201': jsonResponse(description, payload ? envelope(payload) : successEnvelopeSchema),
  };
}

function deleted(description: string): Record<string, ResponseConfig> {
  return { '204': { description } };
}

const ERROR_DESCRIPTIONS: Record<string, string> = {
  '401':
    'No usable access token was presented, or it has expired, been revoked, or was issued ' +
    'for a different audience. An unauthenticated request to an unknown path under /api/v1 ' +
    'also lands here rather than on a 404, so the management surface cannot be probed.',
  '403':
    'The membership behind the token exists but its effective permissions do not cover this ' +
    'action. Also returned when the user belongs to several workspaces and sent no ' +
    'X-Business-Id header to choose between them.',
  '404':
    "No such record inside the caller's workspace. Returned in place of 403 whenever a record " +
    'belongs to another tenant, so no endpoint can be used as an existence oracle.',
  '409':
    'The request conflicts with stored state: a duplicate, a booking race lost at the database ' +
    'exclusion constraint, or a status transition the lifecycle forbids.',
  '422':
    'The payload failed schema validation, or a configured business rule rejected it — notice ' +
    'period, booking horizon, or a per-customer limit. `error.details` names the fields.',
  '429':
    'The rate limit for this bucket was exceeded. The Retry-After header, and ' +
    '`error.meta.retryAfterSeconds`, give the wait in seconds.',
  '500':
    'An unexpected fault. The body carries only a request id; the detail is in the server log.',
  '503': 'A required dependency is unavailable.',
};

function errorResponses(codes: readonly number[]): Record<string, ResponseConfig> {
  const responses: Record<string, ResponseConfig> = {};
  for (const code of codes) {
    const key = String(code);
    responses[key] = jsonResponse(
      ERROR_DESCRIPTIONS[key] ?? 'The request failed.',
      errorEnvelopeSchema,
    );
  }
  return responses;
}

/** Read routes on the authenticated, tenant-scoped surface. */
const MANAGEMENT_ERRORS = [401, 403, 404, 422, 429, 500] as const;
/** Writes add the conflict case: duplicates, races and illegal transitions. */
const MANAGEMENT_WRITE_ERRORS = [401, 403, 404, 409, 422, 429, 500] as const;
/** Authenticated but not tenant-scoped (workspace creation, /auth/me). */
const AUTHENTICATED_ERRORS = [401, 422, 429, 500] as const;
/**
 * The customer surface. 403 is absent and its absence is the documentation:
 * there are no permissions to fail here, because there is no membership to
 * carry them. Something the caller does not own answers 404, exactly as a
 * cross-tenant record does on the management surface and for the same reason.
 */
const PORTAL_ERRORS = [401, 404, 422, 429, 500] as const;
/** Portal writes add the conflict case: a lost booking race, or nothing linked. */
const PORTAL_WRITE_ERRORS = [401, 404, 409, 422, 429, 500] as const;
/** The unauthenticated auth surface. */
const AUTH_ERRORS = [401, 422, 429, 500] as const;
/** The unauthenticated public booking surface. */
const PUBLIC_ERRORS = [404, 422, 429, 500] as const;
const PUBLIC_WRITE_ERRORS = [404, 409, 422, 429, 500] as const;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface OperationInput {
  method: Method;
  path: string;
  tag: string;
  operationId: string;
  summary: string;
  description: string;
  /** Defaults to true. False leaves the operation with no security requirement. */
  authenticated?: boolean;
  /** Adds the X-Business-Id header parameter. */
  tenant?: boolean;
  /** Adds the X-Idempotency-Key header parameter. */
  idempotent?: boolean;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  bodyDescription?: string;
  responses: Record<string, ResponseConfig>;
  errors?: readonly number[];
}

/**
 * Path and query schemas reach the generator as objects.
 *
 * Several of them are `ZodEffects` — a `.refine()` or `.superRefine()` wrapping
 * the object to check one field against another. The generator unwraps those at
 * runtime; this cast is only to say so to the type system, which describes the
 * slot as a bare object.
 */
function asParameterObject(schema: z.ZodTypeAny | undefined): z.AnyZodObject | undefined {
  return schema as z.AnyZodObject | undefined;
}

function operation(input: OperationInput): void {
  const headers: z.ZodTypeAny[] = [];
  if (input.tenant) headers.push(businessIdHeader);
  if (input.idempotent) headers.push(idempotencyHeader);

  const route: RouteConfig = {
    method: input.method,
    path: input.path,
    tags: [input.tag],
    operationId: input.operationId,
    summary: input.summary,
    description: input.description,
    request: {
      params: asParameterObject(input.params),
      query: asParameterObject(input.query),
      headers: headers.length > 0 ? headers : undefined,
      body: input.body
        ? {
            required: true,
            description: input.bodyDescription,
            content: { 'application/json': { schema: input.body } },
          }
        : undefined,
    },
    responses: { ...input.responses, ...errorResponses(input.errors ?? []) },
  };

  if (input.authenticated !== false) {
    route.security = [{ bearerAuth: [] }];
  }

  registry.registerPath(route);
}

/** Registers a request schema as a named component and returns the referencing copy. */
function component<T extends z.ZodTypeAny>(name: string, schema: T): T {
  return registry.register(name, schema);
}

// ---------------------------------------------------------------------------
// Health — mounted on the app root, outside /api/v1
// ---------------------------------------------------------------------------

operation({
  method: 'get',
  path: '/health',
  tag: TAGS.health,
  operationId: 'health.liveness',
  summary: 'Liveness probe',
  description:
    'Answers "is this process alive?". Touches no dependency by design, so a database or ' +
    'Redis blip cannot cause an orchestrator to restart otherwise-healthy instances.',
  authenticated: false,
  responses: { '200': jsonResponse('The process is running.', healthStatusSchema) },
});

operation({
  method: 'get',
  path: '/ready',
  tag: TAGS.health,
  operationId: 'health.readiness',
  summary: 'Readiness probe',
  description:
    'Answers "should this process receive traffic?". PostgreSQL is required and Redis is not, ' +
    'so losing Redis reports `degraded` and still answers 200 while losing PostgreSQL answers ' +
    '503 and takes the instance out of the load balancer.',
  authenticated: false,
  responses: {
    '200': jsonResponse('Ready, or degraded but still serving.', readinessSchema),
    '503': jsonResponse('PostgreSQL is unreachable; this instance cannot serve.', readinessSchema),
  },
});

operation({
  method: 'get',
  path: '/version',
  tag: TAGS.health,
  operationId: 'health.version',
  summary: 'Build and version metadata',
  description:
    'Identifies the service, API version, environment and Node runtime — useful when several ' +
    'revisions run side by side.',
  authenticated: false,
  responses: ok(
    '`data` carries `service`, `apiVersion`, `environment` and `node`.',
    R.versionInfoSchema,
  ),
});

// ---------------------------------------------------------------------------
// Auth — /api/v1/auth
// ---------------------------------------------------------------------------

const registerRequest = component('RegisterRequest', registerSchema);
const loginRequest = component('LoginRequest', loginSchema);
const refreshRequest = component('RefreshRequest', refreshSchema);
const verifyEmailRequest = component('VerifyEmailRequest', verifyEmailSchema);
const requestPasswordResetRequest = component(
  'RequestPasswordResetRequest',
  requestPasswordResetSchema,
);
const resetPasswordRequest = component('ResetPasswordRequest', resetPasswordSchema);
const changePasswordRequest = component('ChangePasswordRequest', changePasswordSchema);

const SESSION_PAYLOAD =
  '`data` carries `user`, `accessToken`, `refreshToken`, `tokenType`, `expiresIn` and ' +
  '`expiresAt`. The refresh token is *also* set as an httpOnly cookie: browser clients should ' +
  'use the cookie and ignore the body copy, which exists for native and server-to-server ' +
  'clients that have no cookie jar.';

operation({
  method: 'get',
  path: '/api/v1/auth/password-policy',
  tag: TAGS.auth,
  operationId: 'auth.passwordPolicy',
  summary: 'Read the password policy',
  description:
    'The rules a password must satisfy, so a sign-up form can enforce them before submitting ' +
    'rather than round-tripping a 422.',
  authenticated: false,
  responses: ok('`data` carries the policy fields and the public app URL.', R.passwordPolicySchema),
  errors: [429, 500],
});

operation({
  method: 'post',
  path: '/api/v1/auth/register',
  tag: TAGS.auth,
  operationId: 'auth.register',
  summary: 'Create an account',
  description:
    'Creates a user and immediately issues a session. A verification email is queued rather ' +
    'than sent inline, so a slow mail provider cannot slow registration and a failed send ' +
    'cannot roll back a created account. The body is strict: a stray `platformRole` is a loud ' +
    '422, never a silently ignored privilege escalation.',
  authenticated: false,
  body: registerRequest,
  responses: created(SESSION_PAYLOAD, R.sessionSchema),
  errors: [409, 422, 429, 500],
});

operation({
  method: 'post',
  path: '/api/v1/auth/login',
  tag: TAGS.auth,
  operationId: 'auth.login',
  summary: 'Sign in',
  description:
    'Exchanges an email and password for a session. Rate limited on IP *and* submitted email, ' +
    'so neither spraying one password across many accounts nor many passwords at one account ' +
    'gets a free pass.',
  authenticated: false,
  body: loginRequest,
  responses: ok(SESSION_PAYLOAD, R.sessionSchema),
  errors: AUTH_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/auth/refresh',
  tag: TAGS.auth,
  operationId: 'auth.refresh',
  summary: 'Exchange a refresh token for a new session',
  description:
    'The token may travel in the body or in the httpOnly cookie; the body field is therefore ' +
    'optional. Rate limited like the credential routes: this is the endpoint an attacker ' +
    'holding a stolen token would hammer, and reuse detection is cheaper when it is not flooded.',
  authenticated: false,
  body: refreshRequest,
  responses: ok(SESSION_PAYLOAD, R.sessionSchema),
  errors: AUTH_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/auth/logout',
  tag: TAGS.auth,
  operationId: 'auth.logout',
  summary: 'Revoke one session',
  description:
    'Revokes the presented refresh token and clears the cookie. Answers 204 whether or not a ' +
    'token was supplied, so a client can always end a session cleanly.',
  authenticated: false,
  body: refreshRequest,
  responses: deleted('The session was ended and the refresh cookie cleared.'),
  errors: [422, 429, 500],
});

operation({
  method: 'post',
  path: '/api/v1/auth/logout-all',
  tag: TAGS.auth,
  operationId: 'auth.logoutAll',
  summary: 'Revoke every session for the current user',
  description: 'Signs the account out everywhere, on every device.',
  responses: ok(
    '`data.sessionsRevoked` counts the refresh tokens that were revoked.',
    R.sessionsRevokedSchema,
  ),
  errors: [401, 429, 500],
});

operation({
  method: 'get',
  path: '/api/v1/auth/me',
  tag: TAGS.auth,
  operationId: 'auth.me',
  summary: 'Read the authenticated user',
  description:
    'Returns the user, every ACTIVE membership they hold, and — once a workspace has been ' +
    "selected for the request — the active workspace with the caller's effective permission " +
    'keys. This is where a client discovers which value to send as X-Business-Id.',
  responses: ok(
    '`activeWorkspace` is null until a workspace has been resolved for the request, which is ' +
      'the normal state for somebody who belongs to several and has sent no X-Business-Id. ' +
      '`customerProfiles` counts the workspaces holding a customer record for this person, and ' +
      'exists so a brand-new owner and a customer — neither of whom holds a membership — can be ' +
      'told apart by something other than an absence.',
    R.authContextSchema,
  ),
  errors: [401, 429, 500],
});

operation({
  method: 'post',
  path: '/api/v1/auth/verify-email',
  tag: TAGS.auth,
  operationId: 'auth.verifyEmail',
  summary: 'Confirm an email address',
  description: 'Consumes the single-use token from the verification email.',
  authenticated: false,
  body: verifyEmailRequest,
  responses: ok('`data.verified` is true.', R.emailVerifiedSchema),
  errors: AUTH_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/auth/password-reset/request',
  tag: TAGS.auth,
  operationId: 'auth.requestPasswordReset',
  summary: 'Request a password reset email',
  description:
    'Always answers the same way whether or not the address is registered, so the endpoint ' +
    'cannot be used to enumerate accounts.',
  authenticated: false,
  body: requestPasswordResetRequest,
  responses: ok('`data` carries a neutral acknowledgement.', R.messageSchema),
  errors: [422, 429, 500],
});

operation({
  method: 'post',
  path: '/api/v1/auth/password-reset/confirm',
  tag: TAGS.auth,
  operationId: 'auth.resetPassword',
  summary: 'Set a new password from a reset token',
  description: 'Consumes the single-use token and revokes existing sessions.',
  authenticated: false,
  body: resetPasswordRequest,
  responses: ok(
    '`data.message` confirms the change and asks the user to sign in again.',
    R.messageSchema,
  ),
  errors: AUTH_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/auth/change-password',
  tag: TAGS.auth,
  operationId: 'auth.changePassword',
  summary: 'Change the password of the signed-in user',
  description: 'Requires the current password, and revokes existing sessions on success.',
  body: changePasswordRequest,
  responses: ok(
    '`data.message` confirms the change and asks the user to sign in again.',
    R.messageSchema,
  ),
  errors: AUTH_ERRORS,
});

// ---------------------------------------------------------------------------
// Workspace — creation is authenticated but deliberately not tenant-scoped
// ---------------------------------------------------------------------------

const createWorkspaceRequest = component('CreateWorkspaceRequest', createBusinessSchema);
const updateWorkspaceRequest = component('UpdateWorkspaceRequest', updateBusinessSchema);
const updateWorkspaceSettingsRequest = component(
  'UpdateWorkspaceSettingsRequest',
  updateSettingsSchema,
);

operation({
  method: 'post',
  path: '/api/v1/workspaces',
  tag: TAGS.workspace,
  operationId: 'workspace.create',
  summary: 'Create a workspace',
  description:
    'Authenticated but not tenant-scoped, and mounted outside the management router for that ' +
    'reason: requiring an existing membership to create your first workspace would make ' +
    'onboarding impossible. The caller becomes its owner.',
  body: createWorkspaceRequest,
  responses: created(
    '`data` carries `business`, the new `membership`, and `staffProfile` or null.',
    R.createdWorkspaceSchema,
  ),
  errors: [401, 409, 422, 429, 500],
});

operation({
  method: 'get',
  path: '/api/v1/workspaces/slug-available',
  tag: TAGS.workspace,
  operationId: 'workspace.checkSlug',
  summary: 'Check whether a workspace slug is free',
  description: 'Lets a sign-up form report a clash before submitting the whole form.',
  query: slugAvailabilitySchema,
  responses: ok('`data` carries `slug` and `available`.', R.slugAvailabilitySchema),
  errors: AUTHENTICATED_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/workspace',
  tag: TAGS.workspace,
  operationId: 'workspace.show',
  summary: 'Read the current workspace',
  description: "The workspace resolved from the caller's membership. Requires `workspace:read`.",
  tenant: true,
  responses: ok('`data` is the workspace record.', R.workspaceSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/workspace',
  tag: TAGS.workspace,
  operationId: 'workspace.update',
  summary: 'Amend the current workspace',
  description:
    'Requires `workspace:update`. `businessId` is absent from the body and always will be: the ' +
    'tenant comes from the membership, so accepting one here would be the client-supplied ' +
    'tenant id the architecture forbids.',
  tenant: true,
  body: updateWorkspaceRequest,
  responses: ok('`data` is the updated workspace record.', R.workspaceSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/workspace/settings',
  tag: TAGS.workspace,
  operationId: 'workspace.showSettings',
  summary: 'Read the booking policy',
  description:
    'Slot interval, buffers, notice, horizon, cancellation and reschedule deadlines, approval ' +
    'and waitlist behaviour. Requires `workspace:read`.',
  tenant: true,
  responses: ok('`data` is the settings record.', R.workspaceSettingsSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/workspace/settings',
  tag: TAGS.workspace,
  operationId: 'workspace.updateSettings',
  summary: 'Amend the booking policy',
  description:
    'Requires `workspace:settings:manage`. Every field is optional so a client can change one ' +
    'value without echoing the rest back.',
  tenant: true,
  body: updateWorkspaceSettingsRequest,
  responses: ok('`data` is the updated settings record.', R.workspaceSettingsSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/workspace/members',
  tag: TAGS.workspace,
  operationId: 'workspace.listMembers',
  summary: 'List workspace members (superseded)',
  description:
    'Every membership in the workspace with its role, unfiltered and unpaginated. Requires ' +
    '`members:read`. Superseded by `GET /api/v1/members`, which answers the same question ' +
    'with paging, search and filters; new clients should use that one. This path still works ' +
    'and is unchanged — retiring it is a breaking change and belongs to a release note rather ' +
    'than to a quiet removal — but it will not gain features.',
  tenant: true,
  responses: ok('`data` is the array of memberships.', z.array(R.workspaceMembershipSchema)),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/workspace/roles',
  tag: TAGS.workspace,
  operationId: 'workspace.listRoles',
  summary: 'List assignable roles',
  description:
    'The roles available in this workspace and the permissions each carries. Requires ' +
    '`roles:read`.',
  tenant: true,
  responses: ok('`data` is the array of roles.', z.array(R.roleSchema)),
  errors: MANAGEMENT_ERRORS,
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

const createLocationRequest = component('CreateLocationRequest', createLocationSchema);
const updateLocationRequest = component('UpdateLocationRequest', updateLocationSchema);

operation({
  method: 'get',
  path: '/api/v1/locations',
  tag: TAGS.locations,
  operationId: 'locations.list',
  summary: 'List locations',
  description: 'Requires `locations:read`.',
  tenant: true,
  query: listLocationsQuerySchema,
  responses: page('`data` is one page of locations.', R.locationSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/locations',
  tag: TAGS.locations,
  operationId: 'locations.create',
  summary: 'Create a location',
  description:
    'Requires `locations:manage`. `timezone` may be omitted, in which case the location ' +
    "inherits the workspace zone rather than the column's UTC default.",
  tenant: true,
  body: createLocationRequest,
  responses: created('`data` is the created location.', R.locationSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/locations/{id}',
  tag: TAGS.locations,
  operationId: 'locations.get',
  summary: 'Read one location',
  description: 'Requires `locations:read`.',
  tenant: true,
  params: locationIdParamSchema,
  responses: ok('`data` is the location.', R.locationSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/locations/{id}',
  tag: TAGS.locations,
  operationId: 'locations.update',
  summary: 'Amend a location',
  description:
    'Requires `locations:manage`. At least one field must be present — an empty patch would ' +
    'write an audit row describing no change at all.',
  tenant: true,
  params: locationIdParamSchema,
  body: updateLocationRequest,
  responses: ok('`data` is the updated location.', R.locationSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/locations/{id}',
  tag: TAGS.locations,
  operationId: 'locations.remove',
  summary: 'Delete a location',
  description: 'Requires `locations:manage`.',
  tenant: true,
  params: locationIdParamSchema,
  responses: deleted('The location was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

const createTeamRequest = component('CreateTeamRequest', createTeamSchema);
const updateTeamRequest = component('UpdateTeamRequest', updateTeamSchema);
const addTeamMemberRequest = component('AddTeamMemberRequest', addTeamMemberSchema);
const updateTeamMemberRequest = component('UpdateTeamMemberRequest', updateTeamMemberSchema);

operation({
  method: 'get',
  path: '/api/v1/teams',
  tag: TAGS.teams,
  operationId: 'teams.list',
  summary: 'List teams',
  description: 'Requires `teams:read`.',
  tenant: true,
  query: listTeamsQuerySchema,
  responses: page('`data` is one page of teams.', R.teamSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/teams',
  tag: TAGS.teams,
  operationId: 'teams.create',
  summary: 'Create a team',
  description:
    'Requires `teams:manage`. The slug is derived from the name when omitted, and validated ' +
    'rather than silently rewritten when supplied.',
  tenant: true,
  body: createTeamRequest,
  responses: created('`data` is the created team.', R.teamSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/teams/{id}',
  tag: TAGS.teams,
  operationId: 'teams.get',
  summary: 'Read one team',
  description: 'Requires `teams:read`.',
  tenant: true,
  params: teamIdParamsSchema,
  responses: ok('`data` is the team with its `members` array.', R.teamDetailSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/teams/{id}',
  tag: TAGS.teams,
  operationId: 'teams.update',
  summary: 'Amend a team',
  description: 'Requires `teams:manage`. At least one field must be present.',
  tenant: true,
  params: teamIdParamsSchema,
  body: updateTeamRequest,
  responses: ok('`data` is the updated team.', R.teamSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/teams/{id}',
  tag: TAGS.teams,
  operationId: 'teams.remove',
  summary: 'Delete a team',
  description: 'Requires `teams:manage`.',
  tenant: true,
  params: teamIdParamsSchema,
  responses: deleted('The team was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/teams/{id}/members',
  tag: TAGS.teams,
  operationId: 'teams.addMember',
  summary: 'Add a staff member to a team',
  description:
    'Requires `teams:manage`. `weight` biases round-robin assignment; `priority` breaks ties, ' +
    'lowest first.',
  tenant: true,
  params: teamIdParamsSchema,
  body: addTeamMemberRequest,
  responses: created('`data` is the created team membership row.', R.teamMemberSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/teams/{id}/members/{memberId}',
  tag: TAGS.teams,
  operationId: 'teams.updateMember',
  summary: 'Amend a team member',
  description:
    'Requires `teams:manage`. Setting `isActive` to false takes the member out of rotation ' +
    'while keeping their history and their place in the team — the join row has no soft delete.',
  tenant: true,
  params: teamMemberParamsSchema,
  body: updateTeamMemberRequest,
  responses: ok('`data` is the updated team membership row.', R.teamMemberSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/teams/{id}/members/{memberId}',
  tag: TAGS.teams,
  operationId: 'teams.removeMember',
  summary: 'Remove a staff member from a team',
  description: 'Requires `teams:manage`.',
  tenant: true,
  params: teamMemberParamsSchema,
  responses: deleted('The member was removed from the team.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

const createStaffRequest = component('CreateStaffRequest', createStaffSchema);
const updateStaffRequest = component('UpdateStaffRequest', updateStaffSchema);
const replaceStaffServicesRequest = component(
  'ReplaceStaffServicesRequest',
  replaceStaffServicesSchema,
);

operation({
  method: 'get',
  path: '/api/v1/staff',
  tag: TAGS.staff,
  operationId: 'staff.list',
  summary: 'List staff profiles',
  description: 'Requires `staff:read`.',
  tenant: true,
  query: listStaffQuerySchema,
  responses: page('`data` is one page of staff profiles.', R.staffProfileSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/staff',
  tag: TAGS.staff,
  operationId: 'staff.create',
  summary: 'Create a staff profile',
  description:
    'Requires `staff:manage`. The person is named only by `membershipId`: the membership ' +
    'proves they already belong to this workspace, and the user id is read off that row, so ' +
    'neither `businessId` nor `userId` is accepted.',
  tenant: true,
  body: createStaffRequest,
  responses: created('`data` is the created staff profile.', R.staffProfileSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/staff/{id}',
  tag: TAGS.staff,
  operationId: 'staff.get',
  summary: 'Read one staff profile',
  description: 'Requires `staff:read`.',
  tenant: true,
  params: staffIdParamsSchema,
  responses: ok('`data` is the staff profile.', R.staffProfileSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/staff/{id}',
  tag: TAGS.staff,
  operationId: 'staff.update',
  summary: 'Amend a staff profile',
  description:
    'Requires `staff:manage`. `membershipId` cannot be changed: rebinding a profile to a ' +
    'different person would silently reassign their whole appointment history.',
  tenant: true,
  params: staffIdParamsSchema,
  body: updateStaffRequest,
  responses: ok('`data` is the updated staff profile.', R.staffProfileSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/staff/{id}',
  tag: TAGS.staff,
  operationId: 'staff.remove',
  summary: 'Delete a staff profile',
  description: 'Requires `staff:manage`.',
  tenant: true,
  params: staffIdParamsSchema,
  responses: deleted('The staff profile was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/staff/{id}/services',
  tag: TAGS.staff,
  operationId: 'staff.listServices',
  summary: 'List the services a staff member delivers',
  description: 'Requires `staff:read`.',
  tenant: true,
  params: staffIdParamsSchema,
  responses: ok(
    '`data` is the array of service assignments.',
    z.array(R.staffServiceAssignmentSchema),
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'put',
  path: '/api/v1/staff/{id}/services',
  tag: TAGS.staff,
  operationId: 'staff.replaceServices',
  summary: 'Replace the services a staff member delivers',
  description:
    'Requires `staff:manage`. PUT, not PATCH: the body is the complete set, and anything ' +
    'absent from it is withdrawn. An empty array is a valid instruction meaning "no services".',
  tenant: true,
  params: staffIdParamsSchema,
  body: replaceStaffServicesRequest,
  responses: ok(
    '`data` is the resulting array of service assignments.',
    z.array(R.staffServiceAssignmentSchema),
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Members — the workspace's people, and the two paths that are not tenant-scoped
//
// `GET /members/invitations` and `POST /members/accept` spell out
// `tenant: false` the way the platform-admin operations do. They are mounted
// above the management router in routes/index.ts because an invitation is
// addressed to somebody whose membership is INVITED, and tenant resolution
// accepts only ACTIVE ones — behind that chain both would 404 for exactly the
// people they exist to serve.
// ---------------------------------------------------------------------------

const inviteMemberRequest = component('InviteMemberRequest', inviteMemberSchema);
const updateMemberRequest = component('UpdateMemberRequest', updateMemberSchema);
const replaceMemberPermissionsRequest = component(
  'ReplaceMemberPermissionsRequest',
  replaceMemberPermissionsSchema,
);
const acceptInvitationRequest = component('AcceptInvitationRequest', acceptInvitationSchema);

operation({
  method: 'get',
  path: '/api/v1/members',
  tag: TAGS.members,
  operationId: 'members.list',
  summary: 'List workspace members',
  description:
    'Requires `members:read`. Supersedes `GET /api/v1/workspace/members`, which still answers ' +
    'but returns an unfiltered, unpaginated array; prefer this one, which adds paging, a ' +
    'search over name and email, and filters on status and role. `includeRemoved` brings back ' +
    'soft-deleted memberships so somebody who left can be found and invited again rather than ' +
    'entered as a stranger.',
  tenant: true,
  query: listMembersQuerySchema,
  responses: page(
    '`data` is one page of members, each with its `user`, `role`, `staffProfile` or null, and ' +
      'an `isOwner` flag marking the account in `businesses.owner_user_id`.',
    R.memberSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/members/invite',
  tag: TAGS.members,
  operationId: 'members.invite',
  summary: 'Invite somebody to the workspace',
  description:
    'Requires `members:invite`. An invitation names an email address, never a user id: ' +
    'accepting one would turn this endpoint into an oracle for which accounts exist on the ' +
    'platform. An address with no account gets one created in the INVITED state together with ' +
    'a set-password link; an address that already has an account is attached to the workspace ' +
    'and the account itself is left completely untouched, so an invitation can never rewrite ' +
    "somebody's name or credentials. The invitation token is emailed, not returned here. A " +
    'live membership for that address is a 409, and a previously removed one is re-invited ' +
    'rather than duplicated.',
  tenant: true,
  body: inviteMemberRequest,
  responses: created('`data` is the created membership in the INVITED state.', R.memberSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/members/{id}',
  tag: TAGS.members,
  operationId: 'members.update',
  summary: "Change a member's role or status",
  description:
    'Requires `members:update`. `status` accepts only ACTIVE and SUSPENDED: INVITED is written ' +
    'by the invitation flow and cleared by acceptance, and REMOVED belongs to the delete ' +
    'route, so neither is a state an operator sets by hand. Three refusals are worth knowing ' +
    'about, and all three answer 409: a caller cannot edit their own membership, nobody can ' +
    "edit the workspace owner's, and the last member holding `roles:manage` cannot be demoted " +
    'or suspended — that one is the fastest way to lock a workspace out of itself. A role ' +
    "change takes effect on the affected person's next request; their existing token keeps " +
    'working and simply carries less authority.',
  tenant: true,
  params: memberIdParamsSchema,
  body: updateMemberRequest,
  responses: ok('`data` is the updated member.', R.memberSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/members/{id}',
  tag: TAGS.members,
  operationId: 'members.remove',
  summary: 'Remove a member from the workspace',
  description:
    'Requires `members:remove`. A soft delete, so the address can be invited again later and ' +
    "the person's audit history stays attributable. Their staff profile is retired in the " +
    'same transaction — leaving it live would keep somebody who has left bookable — and the ' +
    'removal is refused with a 409 while they still hold upcoming appointments, because ' +
    'cancelling or reassigning those is a decision somebody has to make rather than a side ' +
    'effect of tidying up a list. Self-removal, removing the owner and removing the last ' +
    'member who can manage roles are all refused for the same reasons as PATCH.',
  tenant: true,
  params: memberIdParamsSchema,
  responses: deleted('The membership was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/members/{id}/permissions',
  tag: TAGS.members,
  operationId: 'members.permissions',
  summary: 'Read what one member may do',
  description:
    'Requires `members:read`. Answers the question a support conversation actually asks — ' +
    '"why can they not do this?" — by showing the role grant and the per-member exceptions ' +
    'separately, alongside the effective set the authorisation middleware will enforce.',
  tenant: true,
  params: memberIdParamsSchema,
  responses: ok(
    '`data` carries `role`, `rolePermissions`, `overrides` and `effectivePermissions` — role ' +
      'grants plus GRANTs minus DENYs.',
    R.memberPermissionsSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'put',
  path: '/api/v1/members/{id}/permissions',
  tag: TAGS.members,
  operationId: 'members.replacePermissions',
  summary: "Replace one member's permission exceptions",
  description:
    'Requires `roles:manage`, deliberately not the weaker `members:update` a Manager holds: a ' +
    'Manager may change who does which job, not what a job is allowed to do. A full ' +
    'replacement rather than a patch — whatever is absent is deleted — because a merge would ' +
    'make "remove this DENY" impossible to express. Refused on the caller themselves and on ' +
    'the workspace owner, since a DENY placed there is the quickest lockout in the product.',
  tenant: true,
  params: memberIdParamsSchema,
  body: replaceMemberPermissionsRequest,
  responses: ok(
    '`data` is the recomputed permission view, in the shape GET returns.',
    R.memberPermissionsSchema,
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/members/invitations',
  tag: TAGS.members,
  operationId: 'members.listInvitations',
  summary: 'List the invitations addressed to me',
  description:
    'Authenticated and **not** tenant-scoped: the caller has been invited somewhere but ' +
    'belongs nowhere yet, so there is no membership for tenant resolution to find. No ' +
    'permission is checked either, and none is needed — the only rows this can return are ' +
    "invitations addressed to the caller's own account. Each one carries a freshly issued " +
    'token, so a lost invitation email cannot strand somebody.',
  authenticated: true,
  tenant: false,
  responses: ok(
    '`data` is the array of pending invitations, each with the workspace name and slug, the ' +
      'role offered, and a token to present to `POST /api/v1/members/accept`.',
    z.array(R.invitationSchema),
  ),
  errors: AUTHENTICATED_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/members/accept',
  tag: TAGS.members,
  operationId: 'members.acceptInvitation',
  summary: 'Accept an invitation',
  description:
    'Authenticated and **not** tenant-scoped, for the reason above. Both halves are required ' +
    'and neither is sufficient alone: the token says which invitation is being accepted, and ' +
    'the session proves the caller is the person it was addressed to. Everything that fails ' +
    'answers the same 404 — a token that is forged, expired, already used, withdrawn, or ' +
    'addressed to somebody else — so the endpoint cannot be used to probe which memberships ' +
    'exist. On success the membership becomes ACTIVE, which also closes the token: a replay ' +
    'finds nothing in the INVITED state to accept.',
  authenticated: true,
  tenant: false,
  body: acceptInvitationRequest,
  responses: ok(
    '`data` is the now-ACTIVE membership with its workspace and role.',
    R.acceptedInvitationSchema,
  ),
  errors: [401, 404, 422, 429, 500],
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const createServiceCategoryRequest = component(
  'CreateServiceCategoryRequest',
  createCategorySchema,
);
const updateServiceCategoryRequest = component(
  'UpdateServiceCategoryRequest',
  updateCategorySchema,
);
const createServiceRequest = component('CreateServiceRequest', createServiceSchema);
const updateServiceRequest = component('UpdateServiceRequest', updateServiceSchema);
const replaceServiceStaffRequest = component(
  'ReplaceServiceStaffRequest',
  replaceServiceStaffSchema,
);
const replaceServiceLocationsRequest = component(
  'ReplaceServiceLocationsRequest',
  replaceServiceLocationsSchema,
);

operation({
  method: 'get',
  path: '/api/v1/services/categories',
  tag: TAGS.services,
  operationId: 'services.listCategories',
  summary: 'List service categories',
  description: 'Requires `services:read`.',
  tenant: true,
  query: listCategoriesQuerySchema,
  responses: page('`data` is one page of categories.', R.serviceCategorySchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/services/categories',
  tag: TAGS.services,
  operationId: 'services.createCategory',
  summary: 'Create a service category',
  description: 'Requires `services:manage`.',
  tenant: true,
  body: createServiceCategoryRequest,
  responses: created('`data` is the created category.', R.serviceCategorySchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/services/categories/{id}',
  tag: TAGS.services,
  operationId: 'services.updateCategory',
  summary: 'Amend a service category',
  description: 'Requires `services:manage`. At least one field must be present.',
  tenant: true,
  params: categoryIdParamsSchema,
  body: updateServiceCategoryRequest,
  responses: ok('`data` is the updated category.', R.serviceCategorySchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/services/categories/{id}',
  tag: TAGS.services,
  operationId: 'services.removeCategory',
  summary: 'Delete a service category',
  description: 'Requires `services:manage`.',
  tenant: true,
  params: categoryIdParamsSchema,
  responses: deleted('The category was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/services',
  tag: TAGS.services,
  operationId: 'services.list',
  summary: 'List services',
  description: 'Requires `services:read`.',
  tenant: true,
  query: listServicesQuerySchema,
  responses: page('`data` is one page of services.', R.serviceSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/services',
  tag: TAGS.services,
  operationId: 'services.create',
  summary: 'Create a service',
  description:
    'Requires `services:manage`. `priceAmount` is in the smallest currency unit — 1250 for ' +
    '₹12.50 — and a decimal is rejected rather than coerced. The nullable policy overrides ' +
    '(`preBufferMinutes`, `minNoticeMinutes`, `maxHorizonDays`, `slotIntervalMinutes`, ' +
    '`maxPerCustomerPerDay`) mean "inherit the workspace setting" when null and "explicitly ' +
    'none" when 0.',
  tenant: true,
  body: createServiceRequest,
  responses: created('`data` is the created service.', R.serviceSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/services/{id}',
  tag: TAGS.services,
  operationId: 'services.get',
  summary: 'Read one service',
  description: 'Requires `services:read`.',
  tenant: true,
  params: serviceIdParamsSchema,
  responses: ok('`data` is the service.', R.serviceDetailSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/services/{id}',
  tag: TAGS.services,
  operationId: 'services.update',
  summary: 'Amend a service',
  description: 'Requires `services:manage`. At least one field must be present.',
  tenant: true,
  params: serviceIdParamsSchema,
  body: updateServiceRequest,
  responses: ok('`data` is the updated service.', R.serviceSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/services/{id}',
  tag: TAGS.services,
  operationId: 'services.remove',
  summary: 'Delete a service',
  description: 'Requires `services:manage`.',
  tenant: true,
  params: serviceIdParamsSchema,
  responses: deleted('The service was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'put',
  path: '/api/v1/services/{id}/staff',
  tag: TAGS.services,
  operationId: 'services.replaceStaff',
  summary: 'Replace the staff who deliver a service',
  description:
    'Requires `services:manage`. PUT, not PATCH: the body is the complete set the caller wants ' +
    'to end up with. A repeated id is a 422 rather than a silent deduplication, because it ' +
    'would collide with the unique index on the join table.',
  tenant: true,
  params: serviceIdParamsSchema,
  body: replaceServiceStaffRequest,
  responses: ok(
    '`data` is the resulting array of assignments.',
    z.array(R.serviceStaffAssignmentSchema),
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'put',
  path: '/api/v1/services/{id}/locations',
  tag: TAGS.services,
  operationId: 'services.replaceLocations',
  summary: 'Replace the locations a service is offered at',
  description:
    'Requires `services:manage`. An empty array is meaningful: no rows means the service is ' +
    'offered everywhere.',
  tenant: true,
  params: serviceIdParamsSchema,
  body: replaceServiceLocationsRequest,
  responses: ok(
    '`data` is the resulting array of assignments.',
    z.array(R.serviceLocationAssignmentSchema),
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const createResourceRequest = component('CreateResourceRequest', createResourceSchema);
const updateResourceRequest = component('UpdateResourceRequest', updateResourceSchema);
const replaceServiceRequirementsRequest = component(
  'ReplaceServiceResourceRequirementsRequest',
  replaceServiceRequirementsSchema,
);

operation({
  method: 'get',
  path: '/api/v1/resources',
  tag: TAGS.resources,
  operationId: 'resources.list',
  summary: 'List resources',
  description: 'Requires `resources:read`.',
  tenant: true,
  query: listResourcesQuerySchema,
  responses: page('`data` is one page of resources.', R.resourceSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/resources',
  tag: TAGS.resources,
  operationId: 'resources.create',
  summary: 'Create a resource',
  description:
    'Requires `resources:manage`. A null `locationId` means the resource is mobile and travels ' +
    'with the appointment; `capacity` is how many appointments may hold it at the same instant.',
  tenant: true,
  body: createResourceRequest,
  responses: created('`data` is the created resource.', R.resourceSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/resources/{id}',
  tag: TAGS.resources,
  operationId: 'resources.get',
  summary: 'Read one resource',
  description: 'Requires `resources:read`.',
  tenant: true,
  params: resourceIdParamsSchema,
  responses: ok('`data` is the resource.', R.resourceSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/resources/{id}',
  tag: TAGS.resources,
  operationId: 'resources.update',
  summary: 'Amend a resource',
  description: 'Requires `resources:manage`. At least one field must be present.',
  tenant: true,
  params: resourceIdParamsSchema,
  body: updateResourceRequest,
  responses: ok('`data` is the updated resource.', R.resourceSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/resources/{id}',
  tag: TAGS.resources,
  operationId: 'resources.remove',
  summary: 'Delete a resource',
  description: 'Requires `resources:manage`.',
  tenant: true,
  params: resourceIdParamsSchema,
  responses: deleted('The resource was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/resources/requirements/service/{serviceId}',
  tag: TAGS.resources,
  operationId: 'resources.listRequirements',
  summary: 'List the resources a service requires',
  description:
    'Requires `resources:read`. These live under /resources rather than /services because they ' +
    'are edited from the resource-planning screen: a manager who may not touch the catalogue ' +
    'can still say which room a service needs.',
  tenant: true,
  params: resourceServiceIdParamsSchema,
  responses: ok(
    '`data` is the array of requirement rows.',
    z.array(R.serviceResourceRequirementSchema),
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'put',
  path: '/api/v1/resources/requirements/service/{serviceId}',
  tag: TAGS.resources,
  operationId: 'resources.replaceRequirements',
  summary: 'Replace the resources a service requires',
  description:
    'Requires `resources:manage`. Each row names exactly one of `resourceId` (this specific ' +
    'resource) or `resourceType` (any free resource of that type) — never both, never neither. ' +
    'An optional row is reserved when possible and skipped when not, so a nicety never blocks ' +
    'a booking.',
  tenant: true,
  params: resourceServiceIdParamsSchema,
  body: replaceServiceRequirementsRequest,
  responses: ok(
    '`data` is the resulting array of requirement rows.',
    z.array(R.serviceResourceRequirementSchema),
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const createCustomerRequest = component('CreateCustomerRequest', createCustomerSchema);
const updateCustomerRequest = component('UpdateCustomerRequest', updateCustomerSchema);

operation({
  method: 'get',
  path: '/api/v1/customers',
  tag: TAGS.customers,
  operationId: 'customers.list',
  summary: 'List customers',
  description: 'Requires `customers:read`. `search` matches first name, last name and email.',
  tenant: true,
  query: listCustomersQuerySchema,
  responses: page('`data` is one page of customers.', R.customerSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/customers',
  tag: TAGS.customers,
  operationId: 'customers.create',
  summary: 'Create a customer',
  description:
    'Requires `customers:manage`, and additionally `customers:notes:manage` when the body ' +
    'carries `notes` — that rule depends on the payload, so the service enforces it per ' +
    'request rather than the router. Booking counters are read-only and rejected if sent.',
  tenant: true,
  body: createCustomerRequest,
  responses: created('`data` is the created customer.', R.customerSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/customers/{id}',
  tag: TAGS.customers,
  operationId: 'customers.get',
  summary: 'Read one customer',
  description: 'Requires `customers:read`.',
  tenant: true,
  params: customerIdParamSchema,
  responses: ok('`data` is the customer.', R.customerDetailSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/customers/{id}/appointments',
  tag: TAGS.customers,
  operationId: 'customers.listAppointments',
  summary: "List a customer's appointments",
  description: 'Requires `customers:read`.',
  tenant: true,
  params: customerIdParamSchema,
  query: listCustomerAppointmentsQuerySchema,
  responses: page(
    "`data` is one page of the customer's appointments.",
    R.customerAppointmentSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/customers/{id}',
  tag: TAGS.customers,
  operationId: 'customers.update',
  summary: 'Amend a customer',
  description:
    'Requires `customers:manage`, plus `customers:notes:manage` when the patch carries ' +
    '`notes`. `communicationPreferences` is merged over the stored object rather than ' +
    'replacing it, so omitted flags keep their value.',
  tenant: true,
  params: customerIdParamSchema,
  body: updateCustomerRequest,
  responses: ok('`data` is the updated customer.', R.customerSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/customers/{id}',
  tag: TAGS.customers,
  operationId: 'customers.remove',
  summary: 'Delete a customer',
  description: 'Requires `customers:manage`.',
  tenant: true,
  params: customerIdParamSchema,
  responses: deleted('The customer was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const replaceBusinessHoursRequest = component(
  'ReplaceBusinessHoursRequest',
  replaceBusinessHoursSchema,
);
const replaceStaffRulesRequest = component(
  'ReplaceStaffAvailabilityRulesRequest',
  replaceStaffRulesSchema,
);
const createOverrideRequest = component('CreateAvailabilityOverrideRequest', createOverrideSchema);
const createHolidayRequest = component('CreateHolidayRequest', createHolidaySchema);
const createBlackoutRequest = component('CreateBlackoutRequest', createBlackoutSchema);

const WALL_CLOCK_NOTE =
  'Windows are authored as `HH:mm` wall-clock times and stored as minutes from local midnight. ' +
  'An end at or before the start is read as running into the next day, so 22:00–02:00 is a ' +
  'single overnight window. `24:00` is midnight at the *end* of a day and may only close one.';

operation({
  method: 'get',
  path: '/api/v1/availability/business-hours',
  tag: TAGS.availability,
  operationId: 'availability.listBusinessHours',
  summary: 'List opening hours',
  description:
    'Requires `availability:read`. Omitting `locationId` returns the business-wide set — the ' +
    'same set PUT replaces when its body carries no locationId, so one GET round-trips into ' +
    'one PUT.',
  tenant: true,
  query: listBusinessHoursQuerySchema,
  responses: page('`data` is one page of opening-hours windows.', R.businessHoursSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'put',
  path: '/api/v1/availability/business-hours',
  tag: TAGS.availability,
  operationId: 'availability.replaceBusinessHours',
  summary: 'Replace opening hours',
  description:
    'Requires `availability:manage`. PUT, not PATCH: the body is the complete week for the ' +
    'named scope, and an empty array means "this scope has no opening hours at all". ' +
    'Overlapping active windows are rejected with the offending index. ' +
    WALL_CLOCK_NOTE,
  tenant: true,
  body: replaceBusinessHoursRequest,
  responses: ok('`data` is the resulting array of windows.', z.array(R.businessHoursSchema)),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/availability/staff/{staffProfileId}/rules',
  tag: TAGS.availability,
  operationId: 'availability.listStaffRules',
  summary: "List a staff member's weekly availability rules",
  description: 'Requires `availability:read`.',
  tenant: true,
  params: staffProfileIdParamsSchema,
  query: listStaffRulesQuerySchema,
  responses: page('`data` is one page of availability rules.', R.staffAvailabilityRuleSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'put',
  path: '/api/v1/availability/staff/{staffProfileId}/rules',
  tag: TAGS.availability,
  operationId: 'availability.replaceStaffRules',
  summary: "Replace a staff member's weekly availability rules",
  description:
    'Requires `availability:manage` or `availability:manage:own`; the service then refuses ' +
    "anything that is not the caller's own row, because whose rota is being edited is a " +
    'property of the request rather than of the route. Overlap detection is deliberately blind ' +
    'to `locationId`: one person cannot be at two sites at once. ' +
    WALL_CLOCK_NOTE,
  tenant: true,
  params: staffProfileIdParamsSchema,
  body: replaceStaffRulesRequest,
  responses: ok('`data` is the resulting array of rules.', z.array(R.staffAvailabilityRuleSchema)),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/availability/overrides',
  tag: TAGS.availability,
  operationId: 'availability.listOverrides',
  summary: 'List availability overrides',
  description: 'Requires `availability:read`.',
  tenant: true,
  query: listOverridesQuerySchema,
  responses: page('`data` is one page of overrides.', R.availabilityOverrideSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/availability/overrides',
  tag: TAGS.availability,
  operationId: 'availability.createOverride',
  summary: 'Create an availability override',
  description:
    'Requires `availability:manage` or `availability:manage:own`. `isAvailable: false` removes ' +
    'time the recurring rules offer; true adds a window. The scope decides which target ids are ' +
    'legal: BUSINESS names none, LOCATION names only a location, STAFF names a staff profile ' +
    'and may narrow to a location, RESOURCE likewise. Give both `startTime` and `endTime` for a ' +
    'partial day, or neither for a whole one.',
  tenant: true,
  body: createOverrideRequest,
  responses: created('`data` is the created override.', R.availabilityOverrideSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/availability/overrides/{id}',
  tag: TAGS.availability,
  operationId: 'availability.removeOverride',
  summary: 'Delete an availability override',
  description: 'Requires `availability:manage` or `availability:manage:own`.',
  tenant: true,
  params: availabilityIdParamsSchema,
  responses: deleted('The override was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/availability/holidays',
  tag: TAGS.availability,
  operationId: 'availability.listHolidays',
  summary: 'List holidays',
  description: 'Requires `availability:read`.',
  tenant: true,
  query: listHolidaysQuerySchema,
  responses: page('`data` is one page of holidays.', R.holidaySchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/availability/holidays',
  tag: TAGS.availability,
  operationId: 'availability.createHoliday',
  summary: 'Create a holiday',
  description:
    'Requires `availability:manage`. A null `locationId` means every location observes it; ' +
    '`isRecurringAnnually` repeats it on the same month and day thereafter; `closesBusiness: ' +
    'false` labels the day for customers without removing any availability.',
  tenant: true,
  body: createHolidayRequest,
  responses: created('`data` is the created holiday.', R.holidaySchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/availability/holidays/{id}',
  tag: TAGS.availability,
  operationId: 'availability.removeHoliday',
  summary: 'Delete a holiday',
  description: 'Requires `availability:manage`.',
  tenant: true,
  params: availabilityIdParamsSchema,
  responses: deleted('The holiday was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/availability/blackouts',
  tag: TAGS.availability,
  operationId: 'availability.listBlackouts',
  summary: 'List blackout periods',
  description: 'Requires `availability:read`.',
  tenant: true,
  query: listBlackoutsQuerySchema,
  responses: page('`data` is one page of blackout periods.', R.blackoutPeriodSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/availability/blackouts',
  tag: TAGS.availability,
  operationId: 'availability.createBlackout',
  summary: 'Create a blackout period',
  description:
    'Requires `availability:manage`. Unlike an override, a blackout is bounded by two instants ' +
    'rather than a calendar day, so both must carry their offset. The same scope/target rule ' +
    'as overrides applies.',
  tenant: true,
  body: createBlackoutRequest,
  responses: created('`data` is the created blackout period.', R.blackoutPeriodSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/availability/blackouts/{id}',
  tag: TAGS.availability,
  operationId: 'availability.removeBlackout',
  summary: 'Delete a blackout period',
  description: 'Requires `availability:manage`.',
  tenant: true,
  params: availabilityIdParamsSchema,
  responses: deleted('The blackout period was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Booking links
// ---------------------------------------------------------------------------

const createBookingLinkRequest = component('CreateBookingLinkRequest', createBookingLinkSchema);
const updateBookingLinkRequest = component('UpdateBookingLinkRequest', updateBookingLinkSchema);
const replaceBookingLinkServicesRequest = component(
  'ReplaceBookingLinkServicesRequest',
  replaceBookingLinkServicesSchema,
);

operation({
  method: 'get',
  path: '/api/v1/booking-links',
  tag: TAGS.bookingLinks,
  operationId: 'bookingLinks.list',
  summary: 'List booking links',
  description: 'Requires `booking-links:read`.',
  tenant: true,
  query: listBookingLinksQuerySchema,
  responses: page('`data` is one page of booking links.', R.bookingLinkSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/booking-links',
  tag: TAGS.bookingLinks,
  operationId: 'bookingLinks.create',
  summary: 'Create a booking link',
  description:
    'Requires `booking-links:manage`. The `type` decides which target the link must name: ' +
    'SINGLE_SERVICE names `serviceId`, TEAM names `teamId`, STAFF names `staffProfileId`, and ' +
    'CATALOG names none because its offering comes from `serviceIds`. Naming a target the type ' +
    'does not use is a 422, not a stored intention the public page will never act on. The slug ' +
    '*is* the public URL, so a supplied one is validated rather than rewritten.',
  tenant: true,
  body: createBookingLinkRequest,
  responses: created('`data` is the created booking link.', R.bookingLinkDetailSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/booking-links/{id}',
  tag: TAGS.bookingLinks,
  operationId: 'bookingLinks.get',
  summary: 'Read one booking link',
  description: 'Requires `booking-links:read`.',
  tenant: true,
  params: bookingLinkIdParamsSchema,
  responses: ok('`data` is the booking link.', R.bookingLinkDetailSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/booking-links/{id}',
  tag: TAGS.bookingLinks,
  operationId: 'bookingLinks.update',
  summary: 'Amend a booking link',
  description:
    'Requires `booking-links:manage`. Only contradictions *within* the patch are caught here; ' +
    'whether the merged row still satisfies the type/target rule depends on the stored target, ' +
    'so the service re-checks the result before writing.',
  tenant: true,
  params: bookingLinkIdParamsSchema,
  body: updateBookingLinkRequest,
  responses: ok('`data` is the updated booking link.', R.bookingLinkDetailSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/booking-links/{id}',
  tag: TAGS.bookingLinks,
  operationId: 'bookingLinks.remove',
  summary: 'Delete a booking link',
  description: 'Requires `booking-links:manage`.',
  tenant: true,
  params: bookingLinkIdParamsSchema,
  responses: deleted('The booking link was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'put',
  path: '/api/v1/booking-links/{id}/services',
  tag: TAGS.bookingLinks,
  operationId: 'bookingLinks.replaceServices',
  summary: 'Replace the services a booking link offers',
  description:
    'Requires `booking-links:manage`. PUT, not PATCH: the body is the complete set, and the ' +
    'array order is the order the public page lists them in.',
  tenant: true,
  params: bookingLinkIdParamsSchema,
  body: replaceBookingLinkServicesRequest,
  responses: ok('`data` is the updated booking link.', R.bookingLinkDetailSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

const createAppointmentRequest = component('CreateAppointmentRequest', createAppointmentSchema);
const updateAppointmentRequest = component('UpdateAppointmentRequest', updateAppointmentSchema);
const rescheduleAppointmentRequest = component(
  'RescheduleAppointmentRequest',
  rescheduleAppointmentSchema,
);
// cancelAppointmentSchema and rejectAppointmentSchema are the same object: both
// take the one optional explanation that is copied into the status history and
// into the customer's email.
const appointmentReasonRequest = component('AppointmentReasonRequest', cancelAppointmentSchema);
const emptyTransitionRequest = component('EmptyTransitionRequest', emptyBodySchema);

operation({
  method: 'get',
  path: '/api/v1/appointments',
  tag: TAGS.appointments,
  operationId: 'appointments.list',
  summary: 'List appointments',
  description:
    'Requires `appointments:read` or `appointments:read:own`. The router admits both and the ' +
    "query layer narrows to the caller's own diary, answering 404 — never 403 — for anything " +
    'outside it. `from`/`to` bound a window rather than a start time: an appointment that began ' +
    'before the window and is still running belongs in it.',
  tenant: true,
  query: listAppointmentsQuerySchema,
  responses: page('`data` is one page of appointments.', R.appointmentListItemSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/appointments/calendar',
  tag: TAGS.appointments,
  operationId: 'appointments.calendar',
  summary: 'Read the diary as calendar events',
  description:
    'Requires `appointments:read` or `appointments:read:own`. `from` and `to` are required ' +
    'here, unlike on the list: a calendar view always has a visible window, so demanding one ' +
    "costs the client nothing and stops a bare request from scanning a workspace's entire " +
    'history. The window may span at most 92 days.',
  tenant: true,
  query: calendarQuerySchema,
  responses: ok(
    '`data` is the array of calendar events; `meta` echoes the window.',
    z.array(R.calendarEventSchema),
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/appointments/availability/slots',
  tag: TAGS.appointments,
  operationId: 'appointments.slots',
  summary: 'Search bookable slots',
  description:
    'Requires `availability:read` rather than a diary permission: reading what *could* be ' +
    'booked is an availability question. `timezone` is the zone the requested calendar days ' +
    'are read in, and `explain=true` returns the Smart Match scores behind each provider ' +
    'choice. The result names the provider for each offered time, which is what POST ' +
    '/api/v1/appointments then requires.',
  tenant: true,
  query: availabilitySlotsQuerySchema,
  responses: ok(
    '`data` carries the offered slots, each with the provider that would take it.',
    R.availabilitySearchSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/appointments',
  tag: TAGS.appointments,
  operationId: 'appointments.create',
  summary: 'Book an appointment',
  description:
    'Requires `appointments:create`. `staffProfileId` is required here, unlike on the public ' +
    'surface: staff-side booking is deliberate assignment, not Smart Match, and the slot search ' +
    'has already named the provider. `internalNotes` is deliberately not accepted — the private ' +
    'operator note is governed by `appointments:notes:manage` and is written through PATCH /{id}. ' +
    'Send X-Idempotency-Key to make a retry safe.',
  tenant: true,
  idempotent: true,
  body: createAppointmentRequest,
  responses: created(
    '`data` carries `appointment`, `participant` and `customer`. `meta.replayed` is true when ' +
      'an idempotency key matched an earlier request, meaning this call created nothing.',
    R.bookingResultSchema,
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/appointments/{id}',
  tag: TAGS.appointments,
  operationId: 'appointments.get',
  summary: 'Read one appointment',
  description: 'Requires `appointments:read` or `appointments:read:own`.',
  tenant: true,
  params: appointmentIdParamSchema,
  responses: ok('`data` is the appointment with its related records.', R.appointmentDetailSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/appointments/{id}',
  tag: TAGS.appointments,
  operationId: 'appointments.update',
  summary: "Amend an appointment's notes and title",
  description:
    'Requires `appointments:update` or `appointments:notes:manage`; which one a given request ' +
    'needs depends on the fields it carries, so the router admits either and the service ' +
    'enforces per field. Times and status are absent by design: moving an appointment must go ' +
    'through POST /{id}/reschedule, which re-verifies the slot and moves the underlying ' +
    'reservations, and status must go through the lifecycle routes, which enforce the state ' +
    'machine.',
  tenant: true,
  params: appointmentIdParamSchema,
  body: updateAppointmentRequest,
  responses: ok('`data` is the updated appointment.', R.appointmentSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/appointments/{id}/reschedule',
  tag: TAGS.appointments,
  operationId: 'appointments.reschedule',
  summary: 'Move an appointment',
  description:
    'Requires `appointments:reschedule`. Omitting `staffProfileId` keeps the current provider; ' +
    'the lifecycle re-verifies the slot and moves the staff and resource reservations either ' +
    'way. A lost race answers 409 SLOT_UNAVAILABLE.',
  tenant: true,
  params: appointmentIdParamSchema,
  body: rescheduleAppointmentRequest,
  responses: ok('`data` is the moved appointment.', R.appointmentSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/appointments/{id}/cancel',
  tag: TAGS.appointments,
  operationId: 'appointments.cancel',
  summary: 'Cancel an appointment',
  description:
    'Requires `appointments:cancel`. The optional reason is copied into the status history and ' +
    "into the customer's email.",
  tenant: true,
  params: appointmentIdParamSchema,
  body: appointmentReasonRequest,
  responses: ok('`data` is the cancelled appointment.', R.appointmentSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/appointments/{id}/approve',
  tag: TAGS.appointments,
  operationId: 'appointments.approve',
  summary: 'Approve a pending appointment',
  description:
    'Requires `appointments:approve`. The body is empty and still validated strictly, so a ' +
    'client that thinks it is sending something is told that it is not.',
  tenant: true,
  params: appointmentIdParamSchema,
  body: emptyTransitionRequest,
  responses: ok('`data` is the approved appointment.', R.appointmentSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/appointments/{id}/reject',
  tag: TAGS.appointments,
  operationId: 'appointments.reject',
  summary: 'Reject a pending appointment',
  description:
    'Requires `appointments:approve` — rejecting is the other half of approving, so a member ' +
    'who may admit a pending booking may also turn it away.',
  tenant: true,
  params: appointmentIdParamSchema,
  body: appointmentReasonRequest,
  responses: ok('`data` is the rejected appointment.', R.appointmentSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/appointments/{id}/check-in',
  tag: TAGS.appointments,
  operationId: 'appointments.checkIn',
  summary: 'Check a customer in',
  description:
    'Requires `appointments:complete`: check-in is the first step of seeing an appointment ' +
    'through, and that is the permission the STAFF role holds for the appointments it runs.',
  tenant: true,
  params: appointmentIdParamSchema,
  body: emptyTransitionRequest,
  responses: ok('`data` is the checked-in appointment.', R.appointmentSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/appointments/{id}/complete',
  tag: TAGS.appointments,
  operationId: 'appointments.complete',
  summary: 'Complete an appointment',
  description: 'Requires `appointments:complete`.',
  tenant: true,
  params: appointmentIdParamSchema,
  body: emptyTransitionRequest,
  responses: ok('`data` is the completed appointment.', R.appointmentSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/appointments/{id}/no-show',
  tag: TAGS.appointments,
  operationId: 'appointments.noShow',
  summary: 'Mark an appointment as a no-show',
  description: 'Requires `appointments:no-show`.',
  tenant: true,
  params: appointmentIdParamSchema,
  body: emptyTransitionRequest,
  responses: ok('`data` is the appointment, now marked as a no-show.', R.appointmentSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

const createWaitlistEntryRequest = component(
  'CreateWaitlistEntryRequest',
  createWaitlistEntrySchema,
);
const updateWaitlistEntryRequest = component(
  'UpdateWaitlistEntryRequest',
  updateWaitlistEntrySchema,
);
const notifyWaitlistEntryRequest = component(
  'NotifyWaitlistEntryRequest',
  notifyWaitlistEntrySchema,
);
const convertWaitlistEntryRequest = component(
  'ConvertWaitlistEntryRequest',
  convertWaitlistEntrySchema,
);

operation({
  method: 'get',
  path: '/api/v1/waitlist',
  tag: TAGS.waitlist,
  operationId: 'waitlist.list',
  summary: 'List waitlist entries',
  description: 'Requires `waitlist:read`.',
  tenant: true,
  query: listWaitlistQuerySchema,
  responses: page('`data` is one page of waitlist entries.', R.waitlistEntrySchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/waitlist',
  tag: TAGS.waitlist,
  operationId: 'waitlist.create',
  summary: 'Add a customer to the waitlist',
  description:
    'Requires `waitlist:manage`. The desired window is a pair of local dates plus a daily ' +
    "minute range, read in `timezone` — which defaults to the customer's own zone when " +
    'omitted. `status`, hold fields and `publicId` are owned by the matcher and the lifecycle, ' +
    'so sending any of them is a 422 rather than a way to hand yourself a hold.',
  tenant: true,
  body: createWaitlistEntryRequest,
  responses: created('`data` is the created waitlist entry.', R.waitlistEntrySchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/waitlist/{id}',
  tag: TAGS.waitlist,
  operationId: 'waitlist.get',
  summary: 'Read one waitlist entry',
  description: 'Requires `waitlist:read`.',
  tenant: true,
  params: waitlistIdParamSchema,
  responses: ok('`data` is the waitlist entry.', R.waitlistEntrySchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/waitlist/{id}',
  tag: TAGS.waitlist,
  operationId: 'waitlist.update',
  summary: 'Amend a waitlist entry',
  description:
    'Requires `waitlist:manage`. `customerId` and `serviceId` cannot be changed: either would ' +
    'turn this into a different request, which the partial unique index makes a collision ' +
    'rather than an edit. Moving a person to another service is a new entry.',
  tenant: true,
  params: waitlistIdParamSchema,
  body: updateWaitlistEntryRequest,
  responses: ok('`data` is the updated waitlist entry.', R.waitlistEntrySchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/waitlist/{id}',
  tag: TAGS.waitlist,
  operationId: 'waitlist.remove',
  summary: 'Delete a waitlist entry',
  description: 'Requires `waitlist:manage`.',
  tenant: true,
  params: waitlistIdParamSchema,
  responses: deleted('The waitlist entry was removed.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/waitlist/{id}/notify',
  tag: TAGS.waitlist,
  operationId: 'waitlist.notify',
  summary: 'Re-offer a slot to a waitlisted customer',
  description: 'Requires `waitlist:manage`. The body is empty and validated strictly.',
  tenant: true,
  params: waitlistIdParamSchema,
  body: notifyWaitlistEntryRequest,
  responses: ok('`data` is the entry with its updated notification state.', R.waitlistEntrySchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/waitlist/{id}/convert',
  tag: TAGS.waitlist,
  operationId: 'waitlist.convert',
  summary: 'Convert a waitlist entry into a booking',
  description:
    'Requires `waitlist:manage`, which the permission catalogue defines as managing *and ' +
    'converting* entries. Only the instant is accepted: the service, the customer and any ' +
    'staff or location preference are read from the entry, so a conversion cannot quietly book ' +
    'something other than what the customer asked for. Answers 201 because the meaningful ' +
    'outcome is a new appointment.',
  tenant: true,
  params: waitlistIdParamSchema,
  body: convertWaitlistEntryRequest,
  responses: created(
    '`data` carries the updated `entry` and the new `appointment`.',
    R.waitlistConversionSchema,
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const createWebhookRequest = component('CreateWebhookRequest', createWebhookSchema);
const updateWebhookRequest = component('UpdateWebhookRequest', updateWebhookSchema);

/**
 * Repeated on both read operations rather than stated once, because a client
 * author reads one operation and not the section around it, and the thing they
 * must not assume is that the secret can be fetched later.
 */
const WEBHOOK_ENDPOINT_PAYLOAD =
  '`data` carries `id`, `url`, `description`, `events`, `isActive`, `failureCount`, ' +
  '`disabledAt`, `lastSuccessAt`, `lastFailureAt` and timestamps. The signing secret is not ' +
  'among them and cannot be read back — it is returned only by the creation call.';

operation({
  method: 'get',
  path: '/api/v1/webhooks',
  tag: TAGS.webhooks,
  operationId: 'webhooks.list',
  summary: 'List webhook endpoints',
  description:
    'Requires `webhooks:read`. `event` narrows to the endpoints that would be notified of one ' +
    'event, wildcard subscribers included, which is how to answer "who hears about a ' +
    'cancellation?" without reading every row.',
  tenant: true,
  query: listWebhooksQuerySchema,
  responses: page(
    '`data` is one page of endpoints, in the shape described on `GET /api/v1/webhooks/{id}` ' +
      'and without the signing secret.',
    R.webhookEndpointSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/webhooks',
  tag: TAGS.webhooks,
  operationId: 'webhooks.create',
  summary: 'Register a webhook endpoint',
  description:
    'Requires `webhooks:manage`, which the built-in roles grant to owners alone: pointing a ' +
    "workspace's event stream at an arbitrary host is an owner-level act. **The response is " +
    'the only place the signing secret ever appears** — it is excluded from every read by the ' +
    'model default scope, so a client that does not store it now must delete the endpoint and ' +
    'register another. Omitting `events` subscribes to everything, including events added ' +
    'later. A workspace is capped at 20 endpoints, because each one is another insert inside ' +
    'the transaction that takes a booking.',
  tenant: true,
  body: createWebhookRequest,
  responses: created(
    '`data` is the endpoint plus `signingSecret`, and `meta.secretRetrievable` is false to say ' +
      'so in the payload rather than only in this document.',
    R.createdWebhookEndpointSchema,
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/webhooks/{id}',
  tag: TAGS.webhooks,
  operationId: 'webhooks.get',
  summary: 'Read one webhook endpoint',
  description: 'Requires `webhooks:read`. Includes the most recent deliveries for triage.',
  tenant: true,
  params: webhookIdParamsSchema,
  responses: ok(
    `${WEBHOOK_ENDPOINT_PAYLOAD} \`recentDeliveries\` carries the latest attempts.`,
    R.webhookEndpointDetailSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/webhooks/{id}',
  tag: TAGS.webhooks,
  operationId: 'webhooks.update',
  summary: 'Amend a webhook endpoint',
  description:
    'Requires `webhooks:manage`. The signing secret is not amendable and is absent from the ' +
    'body: a caller-supplied secret would be a caller-chosen one, and rotating a secret needs ' +
    'an overlap window rather than a field on a PATCH. Re-enabling an endpoint the delivery ' +
    'worker disabled after repeated failures also clears its failure counter, so the next ' +
    'failure starts the count again rather than tripping the limit immediately.',
  tenant: true,
  params: webhookIdParamsSchema,
  body: updateWebhookRequest,
  responses: ok(WEBHOOK_ENDPOINT_PAYLOAD, R.webhookEndpointSchema),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'delete',
  path: '/api/v1/webhooks/{id}',
  tag: TAGS.webhooks,
  operationId: 'webhooks.remove',
  summary: 'Delete a webhook endpoint',
  description:
    'Requires `webhooks:manage`. A soft delete, so the delivery history stays readable and ' +
    'keeps pointing at a real endpoint: withdrawing a subscription must not erase the record ' +
    'of what was already sent where. Anything still queued for it is marked CANCELLED by the ' +
    'worker rather than quietly dropped.',
  tenant: true,
  params: webhookIdParamsSchema,
  responses: deleted('The endpoint was removed and will receive nothing further.'),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/webhooks/{id}/test',
  tag: TAGS.webhooks,
  operationId: 'webhooks.test',
  summary: 'Send a test event',
  description:
    'Requires `webhooks:manage` rather than `webhooks:read`: nothing about the endpoint ' +
    'changes, but the server opens an outbound connection to a customer-supplied URL, which ' +
    'is a write to the outside world. The `webhook.test` event is not subscribable, so a ' +
    "wildcard subscriber is never woken by somebody else's connectivity check. Answers 201 " +
    'once the delivery is queued — the attempt has not happened yet, and its outcome shows up ' +
    'in the delivery history like any other event. A disabled endpoint is refused with 409 ' +
    'rather than accepted: the worker cancels anything addressed to one, so a 201 here would ' +
    'be the least useful possible answer to "is this endpoint working?".',
  tenant: true,
  params: webhookIdParamsSchema,
  responses: created(
    '`data` is the queued delivery row, initially PENDING.',
    R.webhookDeliverySchema,
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/webhooks/{id}/deliveries',
  tag: TAGS.webhooks,
  operationId: 'webhooks.listDeliveries',
  summary: 'List delivery attempts',
  description:
    'Requires `webhooks:read`. The debugging surface: status, attempt count, the response ' +
    'code and body the far end returned, and the error text when it did not answer at all. ' +
    '`eventId` is stable across every endpoint notified of one occurrence, so a single event ' +
    'can be traced through several subscribers.',
  tenant: true,
  params: webhookIdParamsSchema,
  query: listDeliveriesQuerySchema,
  responses: page(
    '`data` is one page of delivery attempts, newest first, with their payloads.',
    R.webhookDeliverySchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

const ANALYTICS_WINDOW_NOTE =
  'The window is a pair of inclusive calendar dates, not instants: "1 March" means 1 March ' +
  'where the business is, resolved against the workspace timezone inside PostgreSQL. Both ' +
  '`from` and `to` are required — an analytics view always has a visible period, and demanding ' +
  "one stops a bare request from aggregating a workspace's entire history. Neither " +
  '`locationId` nor `staffProfileId` is a tenant selector: both narrow a query already filtered ' +
  "by the caller's proven workspace, so a foreign id reports zeros. Requires `analytics:read`.";

const ANALYTICS_ROUTES: Array<{
  path: string;
  operationId: string;
  summary: string;
  payload: string;
  /** Four of the seven answer with a series, three with a single object. */
  schema: z.ZodTypeAny;
}> = [
  {
    path: 'overview',
    operationId: 'analytics.overview',
    summary: 'Headline figures for a period',
    payload: 'the headline counters for the window',
    schema: R.analyticsOverviewSchema,
  },
  {
    path: 'trends',
    operationId: 'analytics.trends',
    summary: 'Booking volume over time',
    payload: 'the per-interval series for the window',
    schema: z.array(R.analyticsTrendBucketSchema),
  },
  {
    path: 'staff',
    operationId: 'analytics.staff',
    summary: 'Breakdown by staff member',
    payload: 'one row per staff member',
    schema: z.array(R.staffPerformanceSchema),
  },
  {
    path: 'services',
    operationId: 'analytics.services',
    summary: 'Breakdown by service',
    payload: 'one row per service',
    schema: z.array(R.servicePerformanceSchema),
  },
  {
    path: 'locations',
    operationId: 'analytics.locations',
    summary: 'Breakdown by location',
    payload: 'one row per location',
    schema: z.array(R.locationPerformanceSchema),
  },
  {
    path: 'peak-times',
    operationId: 'analytics.peakTimes',
    summary: 'Demand by day and hour',
    payload: 'demand bucketed by weekday and hour',
    schema: z.array(R.peakTimeBucketSchema),
  },
  {
    path: 'customers',
    operationId: 'analytics.customers',
    summary: 'Customer acquisition and retention',
    payload: 'the customer counters for the window',
    schema: R.customerAnalyticsSchema,
  },
];

for (const route of ANALYTICS_ROUTES) {
  operation({
    method: 'get',
    path: `/api/v1/analytics/${route.path}`,
    tag: TAGS.analytics,
    operationId: route.operationId,
    summary: route.summary,
    description: ANALYTICS_WINDOW_NOTE,
    tenant: true,
    query: analyticsRangeQuerySchema,
    responses: ok(
      `\`data\` carries ${route.payload}; \`meta\` echoes the resolved window.`,
      route.schema,
    ),
    errors: MANAGEMENT_ERRORS,
  });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

operation({
  method: 'get',
  path: '/api/v1/reports/appointments',
  tag: TAGS.reports,
  operationId: 'reports.appointments',
  summary: 'List appointments as a report',
  description:
    'Requires `reports:read`. `from`/`to` are optional here, unlike on the analytics surface — ' +
    'a report is a record-keeping tool, and "every appointment this branch has ever had" is a ' +
    'legitimate question. When both are supplied the same 366-day cap applies, so a range ' +
    'filter cannot be used to force an unindexed scan.',
  tenant: true,
  query: appointmentReportQuerySchema,
  responses: page('`data` is one page of report rows.', R.appointmentReportRowSchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/reports/appointments.csv',
  tag: TAGS.reports,
  operationId: 'reports.exportAppointments',
  summary: 'Export the appointment report as CSV',
  description:
    'Requires `reports:read` **and** `reports:export`: an export is a read that leaves the ' +
    'building, so it needs the permission to read and the separate permission to take a copy. ' +
    'Takes the same filters as the JSON report so the file always reproduces the table an ' +
    'operator was looking at, but no pagination — it is bounded by a hard row cap instead, ' +
    'because a page number would only produce a truncated file that looks complete. The ' +
    'response carries `X-Report-Row-Limit`, `X-Report-Matched-Rows` and `X-Report-Truncated` ' +
    'headers, and a Content-Disposition that makes a browser save it.',
  tenant: true,
  query: appointmentExportQuerySchema,
  responses: {
    '200': {
      description: 'The report as a CSV document.',
      content: {
        'text/csv': {
          schema: z.string().openapi({ description: 'CSV, UTF-8, one appointment per row.' }),
        },
      },
    },
  },
  errors: MANAGEMENT_ERRORS,
});

// ---------------------------------------------------------------------------
// Audit — /api/v1/audit-logs
//
// Not a variant of /api/v1/admin/audit-logs, and the difference is the whole
// design: that surface reads across tenants for an operator who holds no
// membership, so a workspace id is ordinary input over there. Here the
// workspace comes from the membership and no parameter below can widen it.
// ---------------------------------------------------------------------------

const AUDIT_ENTRY_FIELDS =
  '`actorType`, `actorUserId`, `actorCustomerId`, `actorLabel`, `action`, `entityType`, ' +
  '`entityId`, `requestId`, `ipAddress`, `createdAt` and `metadata`';

const AUDIT_ENTRY_NOTE =
  '`actorLabel` is the snapshot taken when the entry was written, so an account renamed or ' +
  'deleted afterwards does not rewrite what the trail says happened, and nothing here is ' +
  'resolved through a join for the same reason. `businessId` is not among the fields: every ' +
  "row this surface can return is the caller's own, and echoing the id back would imply the " +
  'feed could ever hold anything else.';

operation({
  method: 'get',
  path: '/api/v1/audit-logs',
  tag: TAGS.audit,
  operationId: 'audit.list',
  summary: 'Read the workspace audit trail',
  description:
    'Requires `audit:read`. Newest first, filterable by `action`, `entityType`, `entityId`, ' +
    '`actorUserId`, a date range and a free-text `search` over the actor, the verb and the ' +
    'entity type. `from` and `to` are calendar dates cut into whole days on the *workspace* ' +
    'clock rather than in UTC — a tenant asking what happened on 3 March means their 3 March ' +
    '— and the zone used is reported back as `meta.timezone` so a client can label its date ' +
    'pickers honestly.',
  tenant: true,
  query: listAuditEntriesQuerySchema,
  responses: page(
    `\`data\` is one page of entries, each carrying ${AUDIT_ENTRY_FIELDS}. ${AUDIT_ENTRY_NOTE}`,
    R.auditEntrySchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/audit-logs/export.csv',
  tag: TAGS.audit,
  operationId: 'audit.export',
  summary: 'Export the audit trail as CSV',
  description:
    'Requires `audit:read` **and** `reports:export`, on the same reading as the appointment ' +
    'export: taking a copy out of the product is a separate act from reading it on screen. ' +
    'Takes the same filters as the list and no pagination — it is bounded by a hard row cap ' +
    'instead, because a page number would only produce a truncated file that looks complete. ' +
    'The response carries `X-Report-Row-Limit`, `X-Report-Matched-Rows` and ' +
    '`X-Report-Truncated`, plus `Cache-Control: no-store`, since the file names people, ' +
    'addresses and what they did. The export writes an audit entry of its own before the ' +
    'first byte: an owner taking the trail out of the product is exactly the event the trail ' +
    'exists to record.',
  tenant: true,
  query: exportAuditEntriesQuerySchema,
  responses: {
    '200': {
      description: 'The trail as a CSV document.',
      content: {
        'text/csv': {
          schema: z.string().openapi({ description: 'CSV, UTF-8, one audit entry per row.' }),
        },
      },
    },
  },
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/audit-logs/{id}',
  tag: TAGS.audit,
  operationId: 'audit.get',
  summary: 'Read one audit entry',
  description:
    'Requires `audit:read`. An entry belonging to another workspace, or a platform-level entry ' +
    'with no workspace at all, answers 404 rather than 403 — the id is matched against the ' +
    "caller's own workspace in the same statement, so a foreign id simply finds no row. Adds " +
    '`userAgent` to the list shape: it is repetitive twenty rows at a time and exactly what an ' +
    'investigation into one entry wants.',
  tenant: true,
  params: auditEntryIdParamsSchema,
  responses: ok(
    `\`data\` is the entry, carrying ${AUDIT_ENTRY_FIELDS} plus \`userAgent\`. ` + AUDIT_ENTRY_NOTE,
    R.auditEntryDetailSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

// ---------------------------------------------------------------------------
// Platform admin — /api/v1/admin, operators only
//
// Every operation below spells out `authenticated: true` and `tenant: false`
// even though both match the defaults. This is the one authenticated surface in
// the product that is not tenant-scoped, and saying so on each operation beats
// leaving a reader to infer it from an absent header.
// ---------------------------------------------------------------------------

const updateWorkspaceStatusRequest = component(
  'UpdateWorkspaceStatusRequest',
  updateWorkspaceStatusSchema,
);
const updateUserStatusRequest = component('UpdateUserStatusRequest', updateUserStatusSchema);
const updatePlatformRoleRequest = component('UpdatePlatformRoleRequest', updatePlatformRoleSchema);

operation({
  method: 'get',
  path: '/api/v1/admin/overview',
  tag: TAGS.admin,
  operationId: 'adminOverview',
  summary: 'Platform-wide headline figures',
  description:
    'Requires platform administrator access. Counts workspaces, accounts, appointments and ' +
    'customers across every tenant. Volume is cut on when a booking was taken rather than on ' +
    'when it falls due, so the fourteen-day series answers "how much work came in" rather than ' +
    '"how full is the diary"; only the upcoming counter reads the appointment start. The ' +
    'customer figure is a total and nothing else — no part of this payload identifies a person ' +
    'a workspace books.',
  authenticated: true,
  tenant: false,
  responses: ok(
    '`data` carries the workspace, user, appointment and customer counters, a `bookingsByDay` ' +
      'series of exactly 14 UTC days ending today and zero-filled, and the five workspaces ' +
      'with the most bookings taken in the last 30 days.',
    R.adminOverviewSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/admin/workspaces',
  tag: TAGS.admin,
  operationId: 'adminListWorkspaces',
  summary: 'List every workspace on the platform',
  description:
    'Requires platform administrator access. The one directory in the product that spans ' +
    'tenants, which is why each row carries counts and the owning account rather than any of ' +
    "the workspace's own records. `search` matches name or slug case-insensitively with LIKE " +
    'wildcards escaped, so a search for `%` looks for a literal per cent sign instead of ' +
    'matching everything.',
  authenticated: true,
  tenant: false,
  query: listWorkspacesQuerySchema,
  responses: page(
    '`data` is one page of workspace summaries, each with its member, staff, service, ' +
      'location, appointment and customer counts.',
    R.adminWorkspaceSummarySchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/admin/workspaces/{id}',
  tag: TAGS.admin,
  operationId: 'adminGetWorkspace',
  summary: 'Read one workspace',
  description:
    'Requires platform administrator access. Adds the profile fields, the member list, a ' +
    'breakdown of appointments by status and the twenty most recent audit entries for this ' +
    'workspace. Members are platform accounts, not customers: an operator can see who ' +
    'administers a clinic and never who it treats. A soft-deleted workspace answers 404 like ' +
    'any unknown id — it is no longer administrable, and must be indistinguishable from one ' +
    'that never existed.',
  authenticated: true,
  tenant: false,
  params: workspaceIdParamsSchema,
  responses: ok(
    '`data` is the workspace summary plus `members`, `appointmentsByStatus` and ' +
      '`recentActivity`.',
    R.adminWorkspaceDetailSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/admin/workspaces/{id}/status',
  tag: TAGS.admin,
  operationId: 'adminUpdateWorkspaceStatus',
  summary: 'Suspend, archive or restore a workspace',
  description:
    'Requires platform administrator access. Suspending a workspace closes it from both ' +
    'directions at once: tenant resolution only accepts an ACTIVE business, so every ' +
    'management call its members make begins answering 404, and its public booking pages stop ' +
    'serving. Nothing is deleted and no appointment is cancelled — setting the workspace back ' +
    'to ACTIVE returns it exactly as it was. The optional `reason` is stored only on the audit ' +
    'row, written in the same transaction as the change, because "why was this suspended" is a ' +
    'question that arrives weeks later.',
  authenticated: true,
  tenant: false,
  params: workspaceIdParamsSchema,
  body: updateWorkspaceStatusRequest,
  responses: ok(
    '`data` is the workspace detail, re-read after the change committed.',
    R.adminWorkspaceDetailSchema,
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/admin/users',
  tag: TAGS.admin,
  operationId: 'adminListUsers',
  summary: 'List platform accounts',
  description:
    'Requires platform administrator access. These are the people who sign in, not the ' +
    'customers a workspace books — the two never meet on this surface. `search` matches email, ' +
    'first name or last name case-insensitively. `workspaceCount` ignores memberships in ' +
    'soft-deleted workspaces, so it always equals the length of the membership list the detail ' +
    'endpoint returns.',
  authenticated: true,
  tenant: false,
  query: listUsersQuerySchema,
  responses: page(
    '`data` is one page of account summaries with their workspace counts.',
    R.adminUserSummarySchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/admin/users/{id}',
  tag: TAGS.admin,
  operationId: 'adminGetUser',
  summary: 'Read one platform account',
  description:
    'Requires platform administrator access. Adds contact and locale settings, lockout state, ' +
    'the number of refresh-token sessions still live, and every workspace the account belongs ' +
    'to with the role it holds there. `activeSessionCount` is the honest answer to "is this ' +
    'person still signed in somewhere", which is what an operator needs both before suspending ' +
    'an account and immediately afterwards.',
  authenticated: true,
  tenant: false,
  params: userIdParamsSchema,
  responses: ok(
    '`data` is the account summary plus its session state and `memberships`.',
    R.adminUserDetailSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/admin/users/{id}/status',
  tag: TAGS.admin,
  operationId: 'adminUpdateUserStatus',
  summary: 'Suspend, deactivate or reinstate an account',
  description:
    'Requires platform administrator access. Suspending or deactivating an account revokes ' +
    'every live refresh token in the same transaction as the status change, so a session ' +
    'cannot outlive the decision; authentication refuses a SUSPENDED or DEACTIVATED user on ' +
    'every request, so the access token already in their hands dies at its next call too. ' +
    'Reinstating revokes nothing — the person simply signs in again. Changing your own status ' +
    'is refused with 409: an operator who suspends themselves has closed the only surface that ' +
    'could let them back in. INVITED is not accepted, because it is a state the invitation ' +
    'flow owns and setting it by hand would strand the account.',
  authenticated: true,
  tenant: false,
  params: userIdParamsSchema,
  body: updateUserStatusRequest,
  responses: ok(
    '`data` is the account detail, re-read after the change committed.',
    R.adminUserDetailSchema,
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/admin/users/{id}/platform-role',
  tag: TAGS.admin,
  operationId: 'adminUpdatePlatformRole',
  summary: 'Grant or withdraw platform administrator access',
  description:
    'Requires platform administrator access. ADMIN is not a workspace role: it grants this ' +
    'entire surface and nothing at all inside any tenant. Two demotions are refused with 409 — ' +
    'your own, and one that would leave the platform with no ACTIVE administrator. The second ' +
    'is decided under a row lock, so two operators demoting each other at the same moment ' +
    'cannot both read "there is still another admin" and both succeed.',
  authenticated: true,
  tenant: false,
  params: userIdParamsSchema,
  body: updatePlatformRoleRequest,
  responses: ok(
    '`data` is the account detail, re-read after the change committed.',
    R.adminUserDetailSchema,
  ),
  errors: MANAGEMENT_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/admin/audit-logs',
  tag: TAGS.admin,
  operationId: 'adminListAuditLogs',
  summary: 'Search the audit trail across tenants',
  description:
    'Requires platform administrator access. The same rows a workspace sees in its own ' +
    'activity feed, plus the platform-level ones that belong to no tenant and carry a null ' +
    '`businessId`. `from` and `to` are inclusive calendar dates compared against the moment ' +
    'the row was written, and rows come back newest first. `businessId` narrows the search ' +
    'here rather than asserting a tenant — the distinction that makes this surface possible at ' +
    'all.',
  authenticated: true,
  tenant: false,
  query: listAuditLogsQuerySchema,
  responses: page('`data` is one page of audit entries, newest first.', R.adminAuditEntrySchema),
  errors: MANAGEMENT_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/admin/health',
  tag: TAGS.admin,
  operationId: 'adminSystemHealth',
  summary: 'Dependency and delivery-backlog status',
  description:
    'Requires platform administrator access. Distinct from the unauthenticated /health and ' +
    '/ready probes, which answer "is this process alive" for an orchestrator: this one reports ' +
    'on PostgreSQL, Redis and the notification outbox, which is operator information rather ' +
    'than something to expose at the edge. It answers 200 even when a dependency is down — a ' +
    '503 would make the one page that could explain an outage disappear during one — so read ' +
    '`database.ok`, `redis.ok` and the outbox counters rather than the status code.',
  authenticated: true,
  tenant: false,
  responses: ok(
    '`data` carries the database and Redis checks, the outbox backlog including `dueNow` and ' +
      'the age of the oldest pending message, and the API build metadata.',
    R.adminHealthSchema,
  ),
  errors: MANAGEMENT_ERRORS,
});

// ---------------------------------------------------------------------------
// Customer portal — /api/v1/me, authenticated but not tenant-scoped
//
// Every operation below spells out `authenticated: true` and `tenant: false`,
// as the platform-admin ones do and for the mirror-image reason: an operator
// stands above every workspace, a customer outside all of them, and neither has
// a membership for `requireTenant` to resolve. Saying so on each operation
// beats leaving a reader to infer it from an absent header.
//
// No operation here takes a workspace, customer or appointment id in any form.
// Bookings are addressed by the same opaque apt_ handle the confirmation email
// carries, and the scope is the caller's own customer records — resolved from
// the access token, never from anything the client sent.
// ---------------------------------------------------------------------------

const cancelBookingRequest = component('PortalCancelBookingRequest', cancelBookingSchema);
const rescheduleBookingRequest = component(
  'PortalRescheduleBookingRequest',
  rescheduleBookingSchema,
);
const updatePreferencesRequest = component('UpdatePreferencesRequest', updatePreferencesSchema);

operation({
  method: 'get',
  path: '/api/v1/me/profile',
  tag: TAGS.customerPortal,
  operationId: 'portal.profile',
  summary: 'Read my profile and the workspaces that know me',
  description:
    'Authenticated, not tenant-scoped, and no permission is checked — there is no membership ' +
    'to carry one. Reading this also reconciles the account with any address-book record that ' +
    'shares its email and is not yet linked, but **only once the address has been verified**: ' +
    'registration accepts any address, so linking on a bare email match would be an ' +
    'account-takeover primitive. Past that gate the link grants nothing new, since every one ' +
    'of those bookings already had its manage link delivered to that mailbox.',
  authenticated: true,
  tenant: false,
  responses: ok(
    '`upcomingBookings` is a count across every workspace, not a list — the bookings themselves ' +
      'are at `GET /api/v1/me/bookings`. Each workspace is identified by the `cus_` handle of ' +
      "this person's record in it, never by an internal id.",
    R.portalProfileSchema,
  ),
  errors: PORTAL_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/me/bookings',
  tag: TAGS.customerPortal,
  operationId: 'portal.listBookings',
  summary: 'List my bookings',
  description:
    'Every workspace at once, which is the point: a person does not think of their diary one ' +
    'business at a time. `when` names the intent — UPCOMING sorts soonest first, PAST sorts ' +
    'most recent first — so a dashboard does not have to send a sort order it would get wrong ' +
    'half the time. Rows are the summary shape: enough to render a card and decide what to ' +
    'open, with `internalNotes` and the rest of the staff-facing detail deliberately absent.',
  authenticated: true,
  tenant: false,
  query: listBookingsQuerySchema,
  responses: page(
    '`data` is one page of bookings, each with its business, service, staff and location ' +
      'summaries and the times in the workspace timezone.',
    R.portalBookingSummarySchema,
  ),
  errors: PORTAL_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/me/bookings/{publicId}',
  tag: TAGS.customerPortal,
  operationId: 'portal.getBooking',
  summary: 'Read one of my bookings',
  description:
    'The same projection the anonymous manage link serves, reused rather than reimplemented so ' +
    'the two surfaces cannot drift on what a customer may see. Ownership is part of the query ' +
    'rather than a check applied to its result: a handle belonging to somebody else and a ' +
    'handle that never existed are the same 404.',
  authenticated: true,
  tenant: false,
  params: bookingPublicIdParamsSchema,
  responses: ok(
    '`data` is the booking as the customer-facing projection describes it.',
    R.publicAppointmentSchema,
  ),
  errors: PORTAL_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/me/bookings/{publicId}/cancel',
  tag: TAGS.customerPortal,
  operationId: 'portal.cancelBooking',
  summary: 'Cancel one of my bookings',
  description:
    "Runs the workspace's own cancellation policy — the same code path, and the same notice " +
    'deadline, as the anonymous manage link. Being signed in makes the cancellation ' +
    'attributable, not free: a 422 inside the deadline is the business rule answering, and it ' +
    'answers for a caller who happens to be a member of that workspace too, so this surface ' +
    'cannot become a policy bypass. The status history records a CUSTOMER actor and the audit ' +
    'entry names the user account, which is the one thing an anonymous manage link can never ' +
    'record.',
  authenticated: true,
  tenant: false,
  params: bookingPublicIdParamsSchema,
  body: cancelBookingRequest,
  responses: ok('`data` is the cancelled booking.', R.publicAppointmentSchema),
  errors: PORTAL_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/me/bookings/{publicId}/reschedule',
  tag: TAGS.customerPortal,
  operationId: 'portal.rescheduleBooking',
  summary: 'Move one of my bookings',
  description:
    'Only the new instant is accepted. Provider and location are deliberately refused, as they ' +
    'are on the anonymous surface: the appointment already names both, and letting the ' +
    'customer reassign them would turn a reschedule into a way to book any provider in the ' +
    'workspace, outside whatever the booking link publishes. The reschedule deadline, the ' +
    'notice period and the availability check all apply, and a slot lost to a race answers 409.',
  authenticated: true,
  tenant: false,
  params: bookingPublicIdParamsSchema,
  body: rescheduleBookingRequest,
  responses: ok('`data` is the booking at its new time.', R.publicAppointmentSchema),
  errors: PORTAL_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/me/preferences',
  tag: TAGS.customerPortal,
  operationId: 'portal.getPreferences',
  summary: 'Read my contact preferences',
  description:
    'Folded across every workspace that holds a record of this person, because there is no ' +
    'workspace to pick between — naming one would mean accepting the identifier this surface ' +
    'must never take. When the linked records disagree, which they can because staff edit the ' +
    'same column from the address book, the reported value is the conservative reading and ' +
    '`divergent` is true, so a client can say "varies" rather than presenting one ' +
    "workspace's answer as though it were universal.",
  authenticated: true,
  tenant: false,
  responses: ok(
    '`data` carries `preferences` (`emailEnabled`, `smsEnabled`, `marketingOptIn`, ' +
      '`reminderOffsetsMinutes`), `divergent` and `workspaceCount`.',
    R.portalPreferencesSchema,
  ),
  errors: PORTAL_ERRORS,
});

operation({
  method: 'patch',
  path: '/api/v1/me/preferences',
  tag: TAGS.customerPortal,
  operationId: 'portal.updatePreferences',
  summary: 'Change my contact preferences',
  description:
    'Applied to every linked record in one transaction, with an audit entry written per ' +
    'workspace so each business can see the change in its own trail. Merged over what is ' +
    'stored rather than replacing it, and no field has a default — a default would quietly ' +
    'reset the switches the person left alone. `reminderOffsetsMinutes: null` hands the ' +
    "schedule back to each workspace's own reminder policy. A patch from somebody with no " +
    'linked records answers 409 rather than a 200 that stored nothing.',
  authenticated: true,
  tenant: false,
  body: updatePreferencesRequest,
  responses: ok(
    '`data` is the preference view, in the shape GET returns.',
    R.portalPreferencesSchema,
  ),
  errors: PORTAL_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Public booking — /api/v1/public, unauthenticated
// ---------------------------------------------------------------------------

const createPublicBookingRequest = component(
  'CreatePublicBookingRequest',
  createPublicBookingSchema,
);
const reschedulePublicBookingRequest = component(
  'ReschedulePublicBookingRequest',
  reschedulePublicAppointmentSchema,
);
const cancelPublicBookingRequest = component(
  'CancelPublicBookingRequest',
  cancelPublicAppointmentSchema,
);

operation({
  method: 'get',
  path: '/api/v1/public/booking-links/{slug}',
  tag: TAGS.publicBooking,
  operationId: 'public.showBookingLink',
  summary: 'Read a public booking page',
  description:
    'The workspace is derived from the slug — no tenant identifier is accepted anywhere on ' +
    'this surface. Returns only what the link publishes: its branding, its custom questions ' +
    'and the offering it actually exposes.',
  authenticated: false,
  params: bookingLinkSlugParamsSchema,
  responses: ok(
    '`data` is the public configuration of the booking link.',
    R.publicBookingConfigSchema,
  ),
  errors: PUBLIC_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/public/booking-links/{slug}/availability',
  tag: TAGS.publicBooking,
  operationId: 'public.showAvailability',
  summary: 'Search bookable slots on a public booking page',
  description:
    'Rate limited more tightly than the rest of the surface: a wide date range fans out into a ' +
    "slot search per provider. `timezone` is the customer's own zone and bounds the search to " +
    'their calendar days, so "next Tuesday" means their Tuesday and not the workspace\'s. ' +
    '`staffProfileId` is honoured only when the link lets customers choose their provider.',
  authenticated: false,
  params: bookingLinkSlugParamsSchema,
  query: publicAvailabilityQuerySchema,
  responses: ok('`data` carries the offered slots.', R.publicAvailabilitySchema),
  errors: PUBLIC_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/public/booking-links/{slug}/bookings',
  tag: TAGS.publicBooking,
  operationId: 'public.createBooking',
  summary: 'Book through a public booking page',
  description:
    'No customer identifier is accepted: a caller who could name an existing customer row ' +
    "could attach their booking — and the confirmation email — to somebody else's record, so " +
    'the service matches on the submitted email inside the tenant instead. Omitting ' +
    '`staffProfileId` lets Smart Match assign a provider. `answers` is checked against the ' +
    'questions this link publishes and anything it did not ask for is dropped. Send ' +
    'X-Idempotency-Key to make a retry safe.',
  authenticated: false,
  idempotent: true,
  params: bookingLinkSlugParamsSchema,
  body: createPublicBookingRequest,
  responses: {
    // Both statuses carry the same payload, and `data.replayed` says which of
    // the two happened — so a client that ignores the status code still cannot
    // mistake a replay for a second booking.
    '200': jsonResponse(
      'A replay: the idempotency key matched an earlier request, so this call created nothing ' +
        'and `data` is the original confirmation.',
      envelope(R.publicBookingConfirmationSchema),
    ),
    '201': jsonResponse(
      '`data` is the booking confirmation.',
      envelope(R.publicBookingConfirmationSchema),
    ),
  },
  errors: PUBLIC_WRITE_ERRORS,
});

operation({
  method: 'get',
  path: '/api/v1/public/appointments/{publicId}',
  tag: TAGS.publicBooking,
  operationId: 'public.showAppointment',
  summary: 'Read one booking by its public reference',
  description:
    'Addressed by the opaque `apt_…` handle, never by an internal UUID. That handle behaves ' +
    'like a bearer token, which is why this route never widens: it reads exactly the one ' +
    'appointment named in the path.',
  authenticated: false,
  params: appointmentPublicIdParamsSchema,
  responses: ok(
    '`data` is the customer-facing view of the appointment.',
    R.publicAppointmentSchema,
  ),
  errors: PUBLIC_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/public/appointments/{publicId}/reschedule',
  tag: TAGS.publicBooking,
  operationId: 'public.rescheduleAppointment',
  summary: 'Move a booking from its manage link',
  description:
    'The customer moves the time and nothing else. Provider and location are deliberately not ' +
    'accepted: the appointment already names them, and letting an unauthenticated caller ' +
    'reassign it would turn the manage link into a way to book any provider in the workspace, ' +
    "outside the offering its booking link publishes. Subject to the workspace's reschedule " +
    'deadline and its per-appointment limit.',
  authenticated: false,
  params: appointmentPublicIdParamsSchema,
  body: reschedulePublicBookingRequest,
  responses: ok('`data` is the moved appointment.', R.publicAppointmentSchema),
  errors: PUBLIC_WRITE_ERRORS,
});

operation({
  method: 'post',
  path: '/api/v1/public/appointments/{publicId}/cancel',
  tag: TAGS.publicBooking,
  operationId: 'public.cancelAppointment',
  summary: 'Cancel a booking from its manage link',
  description:
    "Subject to the workspace's cancellation deadline and to `allowCustomerCancel`. The " +
    "optional reason reaches the status history and the operator's notification.",
  authenticated: false,
  params: appointmentPublicIdParamsSchema,
  body: cancelPublicBookingRequest,
  responses: ok('`data` is the cancelled appointment.', R.publicAppointmentSchema),
  errors: PUBLIC_WRITE_ERRORS,
});

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const DESCRIPTION = `
MeetFlow is a multi-tenant scheduling API. Every path below is transcribed from the router, and
every request schema is imported from the module that validates it at runtime — so this document
cannot describe an endpoint the server does not serve, or a payload it would not accept.

### Four surfaces

**\`/api/v1/*\` — authenticated management.** Mounted behind \`authenticate → rate limit →
requireTenant\`, applied at the router rather than per route so a new endpoint cannot ship
unauthenticated. One consequence is intentional: an unauthenticated request to an unknown path
under \`/api/v1\` answers **401, not 404**, so the surface cannot be probed to discover which
endpoints exist.

**\`/api/v1/public/*\` — unauthenticated booking.** Tenant context comes from a validated
booking-link slug, IP rate limits are tight, and only opaque public identifiers are ever exposed.
An unknown path here answers 404 rather than falling through into the authenticated chain and
answering a misleading 401.

**\`/api/v1/admin/*\` — platform administration.** Mounted behind \`authenticate → rate limit →
requirePlatformAdmin\` and deliberately **not** behind \`requireTenant\`: an operator holds no
membership in the workspaces they administer, so tenant resolution would refuse every call. It is
the only surface that reads across tenants, and what it reads is workspaces, platform accounts and
counts — never a workspace's customers, appointments or notes.

**\`/api/v1/me/*\` — the customer.** Authenticated and, for the mirror-image reason, also **not**
behind \`requireTenant\`: a customer is a person who appears in one or more workspaces' address
books and holds no membership at all, so tenant resolution would refuse every call. Its scope is
the customer records tied to the signed-in account, so it returns only rows belonging to the
person asking. Two further paths sit outside tenant resolution for the same class of reason and
say so on the operation: \`POST /api/v1/workspaces\` (no workspace yet) and
\`POST /api/v1/members/accept\` (a membership that is INVITED rather than ACTIVE).

### Choosing a workspace

The tenant a request operates on is derived from an ACTIVE membership row, never from client
input. \`X-Business-Id\` only *selects* among workspaces the authenticated user already belongs
to; an id for one they do not resolves to nothing and the request is refused with 404, not 403.
\`GET /api/v1/auth/me\` lists the memberships a client may choose from.

### Envelopes

Success is \`{ "data": …, "meta"?: … }\`; failure is
\`{ "error": { "code", "message", "details"?, "requestId" } }\`. \`error.code\` is a stable
machine code and safe to switch on; \`requestId\` is echoed in \`X-Request-Id\` and is the handle
that reaches the server-side detail.

### Times

Any field naming a moment must carry its offset (\`Z\` or \`+05:30\`); a bare local string would
be read in whichever zone the server happens to run in. Any field naming a zone must be an IANA
identifier such as \`Asia/Kolkata\` — a fixed offset cannot express DST and would misplace every
slot twice a year. Calendar dates are \`YYYY-MM-DD\` and wall-clock times are \`HH:mm\`.

### Strictness

Every request body and query string is \`.strict()\`: an unrecognised key is a 422, never a
silently ignored field. That is deliberate — a stray \`businessId\` must be a loud rejection
rather than an attempt to write into another tenant that a later refactor might start honouring.
`.trim();

/**
 * Builds the OpenAPI 3.0 document from everything registered above.
 *
 * Called on every request path that serves the contract, and by the export
 * scripts, so it stays a pure function of the registry.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'MeetFlow API',
      version: '1.0.0',
      description: DESCRIPTION,
      license: { name: 'UNLICENSED' },
    },
    servers: [
      {
        url: process.env.API_BASE_URL ?? 'http://localhost:4000',
        description: 'The API origin. Paths below already carry the /api/v1 prefix.',
      },
    ],
    tags: TAG_DESCRIPTIONS,
    externalDocs: {
      description: 'Architecture notes and ADRs live alongside this contract in the repository.',
      url: 'https://github.com/meetflow/meetflow',
    },
  });
}
