/**
 * Appointment queries.
 *
 * Everything that *changes* the shape of an appointment lives elsewhere:
 * booking.service.ts creates them, lifecycle.service.ts moves them through the
 * state machine. This file reads, plus the one narrow write neither of those
 * owns — the free text an operator keeps against a booking.
 *
 * Three rules shape every function:
 *
 *  1. `businessId` is always the first parameter and always comes from the
 *     caller's proven membership. A row belonging to another workspace must be
 *     indistinguishable from one that does not exist, so every miss raises
 *     NotFoundError — a 403 would confirm the id is real and turn these
 *     endpoints into an existence oracle for other tenants' diaries.
 *  2. Visibility is part of the query, not a filter the caller may choose.
 *     `appointments:read:own` means a member sees only the appointments assigned
 *     to them; if that narrowing lived only in the list endpoint, the same member
 *     could read — and then cancel — anybody else's booking by naming its id.
 *     Every function here therefore takes a scope, and out-of-scope rows 404 for
 *     exactly the same reason out-of-tenant rows do.
 *  3. The two history tables carry their own `businessId`, so they are read with
 *     their own tenant-scoped queries rather than as nested includes. The filter
 *     is then explicit on every read, and three `hasMany` joins cannot multiply
 *     into a cartesian product of participants × transitions × moves.
 */
import { Op, type InferAttributes, type Transaction, type WhereOptions } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  AppointmentParticipant,
  AppointmentStatusHistory,
  Customer,
  Location,
  RescheduleHistory,
  Service,
  StaffProfile,
} from '../../database/models';
import type { AppointmentStatus } from '../../database/models/Appointment';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import type { TenantContext } from '../auth/context';
import { PERMISSIONS, appointmentVisibility } from '../auth/permissions';
import type {
  CalendarQuery,
  ListAppointmentsQuery,
  UpdateAppointmentBody,
} from './appointments.validation';

const log = createLogger('appointments');

/**
 * How many events one calendar window may render.
 *
 * The window is already capped at a quarter by validation; this is the second
 * bound, for the workspace busy enough to fill it. Exceeding it is reported
 * rather than silently truncated, so a client can narrow the view instead of
 * quietly drawing an incomplete diary.
 */
const CALENDAR_MAX_EVENTS = 2000;

/**
 * How many customers a free-text term may expand into. Generous enough that a
 * real name or address never overflows it, small enough that a one-letter search
 * cannot turn into an `IN` list the width of the address book.
 */
const CUSTOMER_MATCH_LIMIT = 500;

const SERVICE_ATTRIBUTES = ['id', 'name', 'slug', 'durationMinutes', 'color'] as const;
const STAFF_ATTRIBUTES = ['id', 'displayName'] as const;
const LOCATION_ATTRIBUTES = ['id', 'name', 'timezone'] as const;

/** Enough to label a row. Contact details belong to the detail view. */
const CUSTOMER_SUMMARY_ATTRIBUTES = ['id', 'publicId', 'firstName', 'lastName'] as const;

/**
 * The detail view adds the address and phone number: reading one appointment is
 * how a member finds the person they are about to call about it.
 */
const CUSTOMER_DETAIL_ATTRIBUTES = [
  'id',
  'publicId',
  'firstName',
  'lastName',
  'email',
  'phone',
  'timezone',
] as const;

/** A diary row without the notes, answers and buffer arithmetic behind it. */
const LIST_ATTRIBUTES = [
  'id',
  'publicId',
  'status',
  'startsAt',
  'endsAt',
  'durationMinutes',
  'timezone',
  'capacity',
  'bookedCount',
  'priceAmount',
  'currency',
  'source',
  'title',
  'requiresApproval',
  'checkedInAt',
  'cancelledAt',
  'createdAt',
  'serviceId',
  'staffProfileId',
  'locationId',
  'customerId',
] as const;

const CALENDAR_ATTRIBUTES = [
  'id',
  'publicId',
  'title',
  'status',
  'startsAt',
  'endsAt',
  'timezone',
  'capacity',
  'bookedCount',
  'serviceId',
  'staffProfileId',
  'locationId',
] as const;

const LIST_INCLUDES = [
  { model: Service, as: 'service', attributes: [...SERVICE_ATTRIBUTES] },
  { model: StaffProfile, as: 'staffProfile', attributes: [...STAFF_ATTRIBUTES] },
  { model: Location, as: 'location', attributes: [...LOCATION_ATTRIBUTES] },
  { model: Customer, as: 'customer', attributes: [...CUSTOMER_SUMMARY_ATTRIBUTES] },
];

const DETAIL_INCLUDES = [
  { model: Service, as: 'service', attributes: [...SERVICE_ATTRIBUTES] },
  { model: StaffProfile, as: 'staffProfile', attributes: [...STAFF_ATTRIBUTES] },
  { model: Location, as: 'location', attributes: [...LOCATION_ATTRIBUTES] },
  { model: Customer, as: 'customer', attributes: [...CUSTOMER_DETAIL_ATTRIBUTES] },
];

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * The narrowing a caller's permissions impose on every appointment query.
 *
 * `NOTHING` is not the same as being refused: it is a member who may read their
 * own diary but is not a bookable provider, so the honest answer is an empty one
 * rather than an error about a permission they do hold.
 */
export type AppointmentScope =
  { kind: 'ALL' } | { kind: 'OWN'; staffProfileId: string } | { kind: 'NOTHING' };

/**
 * Resolves the caller's scope, refusing outright when they may see no
 * appointments at all.
 *
 * Used by the mutation routes as well as the reads: you cannot act on an
 * appointment you are not allowed to see, and the action permissions
 * (`appointments:cancel` and friends) say what a member may do, never whose
 * bookings they may do it to.
 */
export function scopeOf(tenant: TenantContext): AppointmentScope {
  const visibility = appointmentVisibility(tenant.permissions);

  if (visibility === 'NONE') {
    throw new ForbiddenError('Your role does not allow viewing appointments.', undefined, {
      required: [PERMISSIONS.APPOINTMENTS_READ, PERMISSIONS.APPOINTMENTS_READ_OWN],
    });
  }
  if (visibility === 'ALL') return { kind: 'ALL' };

  return tenant.staffProfileId !== null
    ? { kind: 'OWN', staffProfileId: tenant.staffProfileId }
    : { kind: 'NOTHING' };
}

/** The scope as a WHERE fragment. `NOTHING` is handled before this is reached. */
function scopeWhere(scope: AppointmentScope): { staffProfileId?: string } {
  return scope.kind === 'OWN' ? { staffProfileId: scope.staffProfileId } : {};
}

/**
 * The one place an appointment is loaded by id.
 *
 * Scoped by tenant *and* visibility, so a foreign id, a nonexistent id and
 * somebody else's booking all produce the same answer.
 */
async function findAppointmentOrThrow(
  businessId: string,
  scope: AppointmentScope,
  appointmentId: string,
  transaction?: Transaction,
): Promise<Appointment> {
  if (scope.kind === 'NOTHING') throw new NotFoundError('Appointment');

  const appointment = await Appointment.findOne({
    where: { id: appointmentId, businessId, ...scopeWhere(scope) },
    transaction,
  });
  if (!appointment) throw new NotFoundError('Appointment');
  return appointment;
}

/**
 * Tenant- and visibility-scoped existence check.
 *
 * The lifecycle service does its own tenant scoping but knows nothing about
 * permissions, so the HTTP layer establishes visibility before handing an
 * appointment id to it. Selecting the key alone keeps that a cheap index probe.
 */
export async function assertAppointmentVisible(
  businessId: string,
  scope: AppointmentScope,
  appointmentId: string,
): Promise<void> {
  if (scope.kind === 'NOTHING') throw new NotFoundError('Appointment');

  const appointment = await Appointment.findOne({
    where: { id: appointmentId, businessId, ...scopeWhere(scope) },
    attributes: ['id'],
  });
  if (!appointment) throw new NotFoundError('Appointment');
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** The subset of the query schemas the WHERE builder reads. */
interface AppointmentFilters {
  status?: AppointmentStatus[];
  from?: Date;
  to?: Date;
  staffProfileId?: string;
  serviceId?: string;
  locationId?: string;
  customerId?: string;
  q?: string;
}

/**
 * `%` and `_` are wildcards to LIKE, so an unescaped search term of "%" would
 * return the whole diary instead of the booking being looked for.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Ids of customers in this workspace whose name or address matches `term`.
 *
 * Resolved as its own tenant-scoped query rather than as a join predicate:
 * `findAndCountAll` with a limit builds a subquery, and a `$customer.firstName$`
 * reference does not resolve inside one. Two indexed queries are also easier to
 * reason about than one that must be LEFT JOINed and counted DISTINCT.
 */
async function matchingCustomerIds(businessId: string, term: string): Promise<string[]> {
  const rows = await Customer.findAll({
    where: {
      businessId,
      [Op.or]: [
        { firstName: { [Op.iLike]: term } },
        { lastName: { [Op.iLike]: term } },
        { email: { [Op.iLike]: term } },
      ],
    },
    attributes: ['id'],
    limit: CUSTOMER_MATCH_LIMIT,
  });
  return rows.map((row) => row.id);
}

/**
 * The WHERE for a filtered appointment query, or `null` when the filters and the
 * caller's scope cannot both be satisfied.
 *
 * "Show me Dana's diary" asked by someone who may only see their own is an empty
 * answer, not an error: refusing would confirm that Dana has a diary at all.
 */
async function buildWhere(
  businessId: string,
  scope: AppointmentScope,
  filters: AppointmentFilters,
): Promise<WhereOptions<InferAttributes<Appointment>> | null> {
  if (scope.kind === 'NOTHING') return null;
  if (
    scope.kind === 'OWN' &&
    filters.staffProfileId !== undefined &&
    filters.staffProfileId !== scope.staffProfileId
  ) {
    return null;
  }

  const term = filters.q !== undefined ? `%${escapeLike(filters.q)}%` : null;
  const customerIds = term !== null ? await matchingCustomerIds(businessId, term) : [];

  return {
    businessId,
    ...(filters.status !== undefined ? { status: { [Op.in]: filters.status } } : {}),
    // Overlap, not containment: an appointment that started before the window
    // and is still running is part of that window.
    ...(filters.from !== undefined ? { endsAt: { [Op.gt]: filters.from } } : {}),
    ...(filters.to !== undefined ? { startsAt: { [Op.lt]: filters.to } } : {}),
    ...(filters.serviceId !== undefined ? { serviceId: filters.serviceId } : {}),
    ...(filters.locationId !== undefined ? { locationId: filters.locationId } : {}),
    ...(filters.customerId !== undefined ? { customerId: filters.customerId } : {}),
    ...(term !== null
      ? {
          [Op.or]: [
            { title: { [Op.iLike]: term } },
            { publicId: { [Op.iLike]: term } },
            // Omitted entirely when nothing matched: an empty IN list would make
            // this disjunct always false, which is correct but wasteful to send.
            ...(customerIds.length > 0 ? [{ customerId: { [Op.in]: customerIds } }] : []),
          ],
        }
      : {}),
    ...(filters.staffProfileId !== undefined ? { staffProfileId: filters.staffProfileId } : {}),
    // Last, so the caller's scope always wins the key: a filter can narrow the
    // provider it applies to but can never widen it.
    ...scopeWhere(scope),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface AppointmentPage {
  rows: Appointment[];
  totalItems: number;
}

export async function listAppointments(
  businessId: string,
  scope: AppointmentScope,
  query: ListAppointmentsQuery,
): Promise<AppointmentPage> {
  const where = await buildWhere(businessId, scope, query);
  if (where === null) return { rows: [], totalItems: 0 };

  const { rows, count } = await Appointment.findAndCountAll({
    where,
    attributes: [...LIST_ATTRIBUTES],
    include: LIST_INCLUDES,
    // A diary reads forward; the range filter is what bounds how far. `id` last
    // gives the sort a total order: without it two appointments starting at the
    // same minute can swap places between pages, and one is never shown.
    order: [
      ['startsAt', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

/** One block on a calendar grid: enough to draw and label it, nothing more. */
export interface CalendarEvent {
  id: string;
  publicId: string;
  title: string | null;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  serviceId: string;
  serviceName: string | null;
  color: string | null;
  staffProfileId: string | null;
  staffName: string | null;
  locationId: string | null;
  customerName: string | null;
  capacity: number;
  bookedCount: number;
}

export interface CalendarResult {
  events: CalendarEvent[];
  /** True when the window held more than the render cap. */
  truncated: boolean;
}

function toCalendarEvent(appointment: Appointment): CalendarEvent {
  const service = appointment.get('service') as Service | undefined;
  const staffProfile = appointment.get('staffProfile') as StaffProfile | undefined;
  const customer = appointment.get('customer') as Customer | undefined;

  return {
    id: appointment.id,
    publicId: appointment.publicId,
    // The stored title is whatever an operator renamed the booking to; the
    // service name is the label every booking starts with.
    title: appointment.title ?? service?.name ?? null,
    status: appointment.status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    timezone: appointment.timezone,
    serviceId: appointment.serviceId,
    serviceName: service?.name ?? null,
    color: service?.color ?? null,
    staffProfileId: appointment.staffProfileId,
    staffName: staffProfile?.displayName ?? null,
    locationId: appointment.locationId,
    customerName: customer ? `${customer.firstName} ${customer.lastName ?? ''}`.trim() : null,
    capacity: appointment.capacity,
    bookedCount: appointment.bookedCount,
  };
}

export async function listCalendar(
  businessId: string,
  scope: AppointmentScope,
  query: CalendarQuery,
): Promise<CalendarResult> {
  const where = await buildWhere(businessId, scope, query);
  if (where === null) return { events: [], truncated: false };

  const rows = await Appointment.findAll({
    where,
    attributes: [...CALENDAR_ATTRIBUTES],
    include: [
      { model: Service, as: 'service', attributes: ['id', 'name', 'color'] },
      { model: StaffProfile, as: 'staffProfile', attributes: [...STAFF_ATTRIBUTES] },
      { model: Customer, as: 'customer', attributes: [...CUSTOMER_SUMMARY_ATTRIBUTES] },
    ],
    order: [
      ['startsAt', 'ASC'],
      ['id', 'ASC'],
    ],
    // One over the cap: enough to know the window overflowed without paging
    // through it to find out.
    limit: CALENDAR_MAX_EVENTS + 1,
  });

  return {
    events: rows.slice(0, CALENDAR_MAX_EVENTS).map(toCalendarEvent),
    truncated: rows.length > CALENDAR_MAX_EVENTS,
  };
}

export interface AppointmentDetail {
  appointment: Appointment;
  participants: AppointmentParticipant[];
  statusHistory: AppointmentStatusHistory[];
  rescheduleHistory: RescheduleHistory[];
}

export async function getAppointment(
  businessId: string,
  scope: AppointmentScope,
  appointmentId: string,
): Promise<AppointmentDetail> {
  if (scope.kind === 'NOTHING') throw new NotFoundError('Appointment');

  const appointment = await Appointment.findOne({
    where: { id: appointmentId, businessId, ...scopeWhere(scope) },
    include: DETAIL_INCLUDES,
  });
  if (!appointment) throw new NotFoundError('Appointment');

  // Both history tables carry businessId of their own, so the tenant filter is
  // restated rather than inherited from the row above.
  const [participants, statusHistory, rescheduleHistory] = await Promise.all([
    AppointmentParticipant.findAll({
      where: { appointmentId: appointment.id },
      include: [{ model: Customer, as: 'customer', attributes: [...CUSTOMER_DETAIL_ATTRIBUTES] }],
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
    AppointmentStatusHistory.findAll({
      where: { businessId, appointmentId: appointment.id },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
    RescheduleHistory.findAll({
      where: { businessId, appointmentId: appointment.id },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
  ]);

  return { appointment, participants, statusHistory, rescheduleHistory };
}

// ---------------------------------------------------------------------------
// Notes and title
// ---------------------------------------------------------------------------

export interface AppointmentActor {
  userId: string;
  email: string;
  /**
   * Whether the caller holds APPOINTMENTS_UPDATE and APPOINTMENTS_NOTES_MANAGE.
   * Both are resolved once at the HTTP boundary and passed as plain flags, so
   * this service never needs to know how permissions are stored or resolved.
   *
   * They cannot be settled by the router either: which of the two a PATCH needs
   * depends on the fields the body carries, not on the route it arrived at.
   */
  canUpdateDetails: boolean;
  canManageNotes: boolean;
}

/**
 * The private note is a capability of its own: APPOINTMENTS_UPDATE lets a member
 * keep the booking's own details right, while APPOINTMENTS_NOTES_MANAGE is what
 * lets them write — or erase — the commentary the customer never sees.
 */
function assertMayManageNotes(actor: AppointmentActor): void {
  if (!actor.canManageNotes) {
    throw new ForbiddenError(
      'Your role does not allow writing internal appointment notes.',
      undefined,
      {
        required: [PERMISSIONS.APPOINTMENTS_NOTES_MANAGE],
      },
    );
  }
}

function assertMayUpdateDetails(actor: AppointmentActor): void {
  if (!actor.canUpdateDetails) {
    throw new ForbiddenError('Your role does not allow editing appointment details.', undefined, {
      required: [PERMISSIONS.APPOINTMENTS_UPDATE],
    });
  }
}

/**
 * Amends the free text attached to an appointment.
 *
 * Deliberately the only write in this file, and deliberately unable to touch a
 * time or a status: those belong to lifecycle.service.ts, which re-verifies the
 * slot, moves the reservations and enforces the state machine.
 *
 * A terminal appointment is still editable. "The customer arrived twenty minutes
 * late" is written after the visit, not before it.
 */
export async function updateAppointmentNotes(
  businessId: string,
  scope: AppointmentScope,
  appointmentId: string,
  input: UpdateAppointmentBody,
  actor: AppointmentActor,
  metadata: RequestMetadata,
): Promise<Appointment> {
  // `null` is meaningful on all three: it erases what is already stored, so
  // presence of the key — not a value — is what needs the permission.
  if (input.internalNotes !== undefined) assertMayManageNotes(actor);
  if (input.title !== undefined || input.customerNotes !== undefined) {
    assertMayUpdateDetails(actor);
  }

  return sequelize.transaction(async (transaction) => {
    const appointment = await findAppointmentOrThrow(businessId, scope, appointmentId, transaction);

    await appointment.update(
      {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.customerNotes !== undefined ? { customerNotes: input.customerNotes } : {}),
        ...(input.internalNotes !== undefined ? { internalNotes: input.internalNotes } : {}),
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.APPOINTMENT_UPDATED,
        entityType: 'appointment',
        entityId: appointment.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        // Field names and presence only. Audit rows are append-only and are read
        // by support and exported by owners, so the body of a note — which is
        // often about a person — never goes into one.
        metadata: {
          publicId: appointment.publicId,
          changed: Object.keys(input),
          hasInternalNote: appointment.internalNotes !== null,
          hasCustomerNote: appointment.customerNotes !== null,
        },
      },
      { transaction },
    );

    log.info({ businessId, appointmentId: appointment.id }, 'appointment details updated');
    return appointment;
  });
}
