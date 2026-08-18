/**
 * Customers — the people a workspace books, and their history with it.
 *
 * Four rules shape every function here:
 *
 *  1. `businessId` is always the first parameter and always comes from the
 *     caller's proven membership. A record belonging to another workspace must
 *     be indistinguishable from one that does not exist, so every miss raises
 *     NotFoundError — a 403 would confirm the id is real and turn these
 *     endpoints into an existence oracle for other tenants' customers.
 *  2. `(business_id, email)` is unique among live rows. The address is the
 *     natural key a receptionist types twice, so a duplicate is a 409 the client
 *     can act on, never a database error surfacing as a 500.
 *  3. The denormalised counters (`totalBookings`, `completedCount`,
 *     `cancelledCount`, `noShowCount`) and the first/last appointment stamps are
 *     owned by the booking lifecycle. Nothing in this file writes them; they are
 *     returned read-only.
 *  4. Audit metadata never carries a customer's email or the body of a note.
 *     Audit rows are append-only, so anything copied into them outlives the
 *     record — including a record deleted precisely because the person asked.
 */
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  AppointmentParticipant,
  Business,
  Customer,
  Location,
  Service,
  StaffProfile,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../utils/errors';
import { newCustomerPublicId } from '../../utils/ids';
import { isValidTimezone } from '../../utils/time';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import { PERMISSIONS } from '../auth/permissions';
import type {
  CreateCustomerBody,
  ListCustomerAppointmentsQuery,
  ListCustomersQuery,
  UpdateCustomerBody,
} from './customers.validation';

const log = createLogger('customers');

/** Enough to render a history row without shipping internal notes or answers. */
const APPOINTMENT_SUMMARY_ATTRIBUTES = [
  'id',
  'publicId',
  'status',
  'startsAt',
  'endsAt',
  'durationMinutes',
  'timezone',
  'priceAmount',
  'currency',
  'source',
  'cancelledAt',
  'cancellationReason',
] as const;

const SERVICE_ATTRIBUTES = ['id', 'name', 'slug', 'durationMinutes'] as const;
const STAFF_ATTRIBUTES = ['id', 'displayName'] as const;
const LOCATION_ATTRIBUTES = ['id', 'name', 'timezone'] as const;

/** What a detail panel shows above the fold; the full list has its own endpoint. */
const RECENT_APPOINTMENT_LIMIT = 5;

export interface CustomerActor {
  userId: string;
  email: string;
  /**
   * Whether the caller holds CUSTOMERS_NOTES_MANAGE. Resolved once at the HTTP
   * boundary and passed as a plain flag, so the service never needs to know how
   * permissions are stored or resolved.
   */
  canManageNotes: boolean;
}

export interface CustomerPage {
  rows: Customer[];
  totalItems: number;
}

export interface CustomerAppointmentPage {
  rows: Appointment[];
  totalItems: number;
}

export interface CustomerDetail {
  customer: Customer;
  recentAppointments: Appointment[];
}

/** Joined into every appointment read so a row is readable without a second call. */
const APPOINTMENT_INCLUDES = [
  { model: Service, as: 'service', attributes: [...SERVICE_ATTRIBUTES] },
  { model: StaffProfile, as: 'staffProfile', attributes: [...STAFF_ATTRIBUTES] },
  { model: Location, as: 'location', attributes: [...LOCATION_ATTRIBUTES] },
];

/**
 * `%` and `_` are wildcards to LIKE, so an unescaped search term of "%" would
 * return the entire address book instead of the person being looked for.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The one place a customer is loaded by id.
 *
 * Scoped by `businessId` so a foreign id and a nonexistent id produce the same
 * answer, and left on the paranoid default so a soft-deleted record is gone as
 * far as the API is concerned.
 */
async function findCustomerOrThrow(
  businessId: string,
  customerId: string,
  transaction?: Transaction,
): Promise<Customer> {
  const customer = await Customer.findOne({
    where: { id: customerId, businessId },
    transaction,
  });
  if (!customer) throw new NotFoundError('Customer');
  return customer;
}

function assertTimezone(zone: string): void {
  if (!isValidTimezone(zone)) {
    throw new ValidationError('Invalid timezone.', [
      {
        field: 'timezone',
        message: 'Must be an IANA timezone identifier such as Asia/Kolkata, not a UTC offset.',
      },
    ]);
  }
}

/**
 * Internal notes are a capability of their own: CUSTOMERS_MANAGE lets a member
 * keep the address book accurate, while CUSTOMERS_NOTES_MANAGE is what lets them
 * write — or erase — the private commentary attached to a person.
 */
function assertMayWriteNotes(actor: CustomerActor): void {
  if (!actor.canManageNotes) {
    throw new ForbiddenError('Your role does not allow writing customer notes.', undefined, {
      required: [PERMISSIONS.CUSTOMERS_NOTES_MANAGE],
    });
  }
}

function duplicateEmailError(): ConflictError {
  return new ConflictError(
    'A customer with that email address already exists in this workspace.',
    ErrorCode.ALREADY_EXISTS,
  );
}

/**
 * Mirrors `customers_business_email_unique`, which is filtered to
 * `deleted_at IS NULL` — hence the default paranoid scope: a soft-deleted record
 * must not hold an address hostage against the person re-registering.
 *
 * The column is `citext`, so this equality is case-insensitive in the database
 * as well as at the validation boundary.
 */
async function assertEmailAvailable(
  businessId: string,
  email: string,
  transaction: Transaction,
  excludeId?: string,
): Promise<void> {
  const clash = await Customer.findOne({
    where: {
      businessId,
      email,
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    },
    attributes: ['id'],
    transaction,
  });
  if (clash) throw duplicateEmailError();
}

/**
 * The pre-check above cannot be authoritative: two concurrent creates both read
 * "address free" before either writes, and only the unique index settles it.
 * Translating that violation keeps the loser a 409 instead of a 500.
 */
function translateDuplicateEmail(error: unknown): never {
  if (error instanceof UniqueConstraintError && 'email' in error.fields) {
    throw duplicateEmailError();
  }
  throw error;
}

/** A preferred provider from another workspace must look like one that is absent. */
async function assertStaffInTenant(
  businessId: string,
  staffProfileId: string,
  transaction: Transaction,
): Promise<void> {
  const staff = await StaffProfile.findOne({
    where: { id: staffProfileId, businessId },
    attributes: ['id'],
    transaction,
  });
  if (!staff) throw new NotFoundError('Staff profile');
}

async function assertLocationInTenant(
  businessId: string,
  locationId: string,
  transaction: Transaction,
): Promise<void> {
  const location = await Location.findOne({
    where: { id: locationId, businessId },
    attributes: ['id'],
    transaction,
  });
  if (!location) throw new NotFoundError('Location');
}

export async function listCustomers(
  businessId: string,
  query: ListCustomersQuery,
): Promise<CustomerPage> {
  const term = query.search ? `%${escapeLike(query.search)}%` : null;

  const { rows, count } = await Customer.findAndCountAll({
    where: {
      businessId,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.tag !== undefined ? { tags: { [Op.contains]: [query.tag] } } : {}),
      ...(term
        ? {
            [Op.or]: [
              { firstName: { [Op.iLike]: term } },
              { lastName: { [Op.iLike]: term } },
              { email: { [Op.iLike]: term } },
            ],
          }
        : {}),
    },
    // `id` last gives the sort a total order: without it two people with the
    // same name can swap places between pages, and one of them is never shown.
    order: [
      ['firstName', 'ASC'],
      ['lastName', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

/**
 * One customer plus the head of their history.
 *
 * The appointments are fetched in their own tenant-scoped query rather than as
 * a nested include: the `businessId` filter is then explicit on both reads, and
 * a limited include would otherwise have to be a separate query anyway.
 */
export async function getCustomer(businessId: string, customerId: string): Promise<CustomerDetail> {
  const customer = await Customer.findOne({
    where: { id: customerId, businessId },
    include: [
      { model: StaffProfile, as: 'preferredStaff', attributes: [...STAFF_ATTRIBUTES] },
      { model: Location, as: 'preferredLocation', attributes: [...LOCATION_ATTRIBUTES] },
    ],
  });
  if (!customer) throw new NotFoundError('Customer');

  const recentAppointments = await Appointment.findAll({
    where: { businessId, customerId: customer.id },
    attributes: [...APPOINTMENT_SUMMARY_ATTRIBUTES],
    include: APPOINTMENT_INCLUDES,
    // Newest start time first: anything still upcoming heads the panel and the
    // most recent history follows it.
    order: [
      ['startsAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: RECENT_APPOINTMENT_LIMIT,
  });

  return { customer, recentAppointments };
}

/**
 * Full booking history, paginated.
 *
 * The customer is resolved first so a foreign id answers 404 before any
 * appointment is read, and the appointment query carries the tenant filter of
 * its own regardless.
 */
export async function listCustomerAppointments(
  businessId: string,
  customerId: string,
  query: ListCustomerAppointmentsQuery,
): Promise<CustomerAppointmentPage> {
  const customer = await findCustomerOrThrow(businessId, customerId);

  const { rows, count } = await Appointment.findAndCountAll({
    where: { businessId, customerId: customer.id },
    attributes: [...APPOINTMENT_SUMMARY_ATTRIBUTES],
    include: APPOINTMENT_INCLUDES,
    order: [
      ['startsAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

export async function createCustomer(
  businessId: string,
  input: CreateCustomerBody,
  actor: CustomerActor,
  metadata: RequestMetadata,
): Promise<Customer> {
  if (input.timezone !== undefined) assertTimezone(input.timezone);
  // A create that carries no note needs no note permission; `null` here clears
  // nothing, so only real content is gated.
  if (input.notes !== undefined && input.notes !== null) assertMayWriteNotes(actor);

  return sequelize.transaction(async (transaction) => {
    const business = await Business.findByPk(businessId, {
      attributes: ['id', 'timezone', 'locale'],
      transaction,
    });
    if (!business) throw new NotFoundError('Workspace');

    await assertEmailAvailable(businessId, input.email, transaction);

    if (input.preferredStaffProfileId) {
      await assertStaffInTenant(businessId, input.preferredStaffProfileId, transaction);
    }
    if (input.preferredLocationId) {
      await assertLocationInTenant(businessId, input.preferredLocationId, transaction);
    }

    // A customer with no zone of their own follows the workspace. Falling
    // through to the column default would make it UTC, which is wrong
    // everywhere but one meridian and invisible until a reminder arrives at
    // three in the morning.
    const timezone = input.timezone ?? business.timezone;

    const customer = await Customer.create(
      {
        businessId,
        publicId: newCustomerPublicId(),
        // Set only when the person later signs in; never taken from a request.
        userId: null,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        email: input.email,
        phone: input.phone ?? null,
        timezone,
        locale: input.locale ?? business.locale,
        notes: input.notes ?? null,
        preferredStaffProfileId: input.preferredStaffProfileId ?? null,
        preferredLocationId: input.preferredLocationId ?? null,
        firstAppointmentAt: null,
        lastAppointmentAt: null,
        // Tags, preferences and status fall through to the column defaults when
        // the caller did not choose, so each default is defined in one place.
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.communicationPreferences !== undefined
          ? { communicationPreferences: input.communicationPreferences }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        // The booking counters are absent on purpose: they belong to the
        // lifecycle and start at the column default of zero.
      },
      { transaction },
    ).catch(translateDuplicateEmail);

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.CUSTOMER_CREATED,
        entityType: 'customer',
        entityId: customer.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          publicId: customer.publicId,
          status: customer.status,
          timezone: customer.timezone,
          hasNote: customer.notes !== null,
        },
      },
      { transaction },
    );

    log.info({ businessId, customerId: customer.id }, 'customer created');
    return customer;
  });
}

export async function updateCustomer(
  businessId: string,
  customerId: string,
  input: UpdateCustomerBody,
  actor: CustomerActor,
  metadata: RequestMetadata,
): Promise<Customer> {
  if (input.timezone !== undefined) assertTimezone(input.timezone);
  // Unlike create, `null` is meaningful here: it erases an existing note.
  if (input.notes !== undefined) assertMayWriteNotes(actor);

  return sequelize.transaction(async (transaction) => {
    const customer = await findCustomerOrThrow(businessId, customerId, transaction);

    if (input.email !== undefined && input.email !== customer.email) {
      await assertEmailAvailable(businessId, input.email, transaction, customer.id);
    }
    if (input.preferredStaffProfileId) {
      await assertStaffInTenant(businessId, input.preferredStaffProfileId, transaction);
    }
    if (input.preferredLocationId) {
      await assertLocationInTenant(businessId, input.preferredLocationId, transaction);
    }

    const before = {
      status: customer.status,
      timezone: customer.timezone,
      locale: customer.locale,
      tags: [...customer.tags],
    };

    await customer
      .update(
        {
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.preferredStaffProfileId !== undefined
            ? { preferredStaffProfileId: input.preferredStaffProfileId }
            : {}),
          ...(input.preferredLocationId !== undefined
            ? { preferredLocationId: input.preferredLocationId }
            : {}),
          // Merged, not replaced: a patch that turns SMS on must not silently
          // reset the reminder offsets the customer chose.
          ...(input.communicationPreferences !== undefined
            ? {
                communicationPreferences: {
                  ...customer.communicationPreferences,
                  ...input.communicationPreferences,
                },
              }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
        { transaction },
      )
      .catch(translateDuplicateEmail);

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.CUSTOMER_UPDATED,
        entityType: 'customer',
        entityId: customer.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        // Field names only for the contact details: the trail records that the
        // address changed, not what it changed to.
        metadata: {
          publicId: customer.publicId,
          changed: Object.keys(input),
          before,
          after: {
            status: customer.status,
            timezone: customer.timezone,
            locale: customer.locale,
            tags: [...customer.tags],
          },
        },
      },
      { transaction },
    );

    return customer;
  });
}

/**
 * Appointments that still need this person on the calendar.
 *
 * `endsAt` rather than `startsAt`: an appointment running right now is still
 * theirs. Group bookings name their attendees only in `appointment_participants`,
 * so testing the primary `customer_id` alone would let a record be deleted out
 * from under a class they are sitting in.
 */
async function countBlockingAppointments(
  businessId: string,
  customerId: string,
  transaction: Transaction,
): Promise<number> {
  return Appointment.count({
    where: {
      businessId,
      status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
      endsAt: { [Op.gt]: new Date() },
      [Op.or]: [{ customerId }, { '$participants.customerId$': customerId }],
    },
    include: [
      {
        model: AppointmentParticipant,
        as: 'participants',
        attributes: [],
        required: false,
        // A cancelled place has already been given up, so it must not block.
        where: { status: { [Op.ne]: 'CANCELLED' } },
      },
    ],
    // The join can match one appointment twice (primary column *and* a
    // participant row); without this the operator is told to clear more
    // appointments than exist.
    distinct: true,
    transaction,
  });
}

export async function deleteCustomer(
  businessId: string,
  customerId: string,
  actor: CustomerActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const customer = await findCustomerOrThrow(businessId, customerId, transaction);

    const blocking = await countBlockingAppointments(businessId, customer.id, transaction);
    if (blocking > 0) {
      throw new ConflictError(
        `This customer still has ${blocking} upcoming appointment${blocking === 1 ? '' : 's'}. ` +
          'Cancel them, or set the status to ARCHIVED instead.',
        ErrorCode.CONFLICT,
        { activeAppointments: blocking },
      );
    }

    // Soft delete (the model is paranoid): past appointments keep resolving the
    // person they were booked for, and the partial unique index releases the
    // address so the same person can register again later.
    await customer.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.CUSTOMER_DELETED,
        entityType: 'customer',
        entityId: customer.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        // publicId only. A deletion is often the answer to an erasure request,
        // and audit rows are append-only — copying the address in here would
        // outlive the record it was meant to remove.
        metadata: { publicId: customer.publicId, totalBookings: customer.totalBookings },
      },
      { transaction },
    );

    log.info({ businessId, customerId: customer.id }, 'customer deleted');
  });
}
