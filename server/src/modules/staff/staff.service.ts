/**
 * Staff profiles — the bookable identity of a member inside one workspace.
 *
 * Three invariants govern every function here:
 *
 *  1. `businessId` is always the first parameter and always comes from the
 *     caller's proven membership. A row belonging to another workspace must be
 *     indistinguishable from a row that does not exist, so every miss raises
 *     NotFoundError — never a 403, which would confirm the id is real.
 *  2. The user a profile belongs to is read off the membership row, never off
 *     the request. A body-supplied `userId` would let a manager mint a bookable
 *     identity for an account that has no business being in the workspace.
 *  3. `service_staff` carries no `business_id`. It is only ever reached through
 *     a staff profile that has already been proven to belong to the tenant, and
 *     the service on the other side is re-checked against the same businessId.
 */
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  AppointmentStaff,
  Business,
  Location,
  Membership,
  Service,
  ServiceStaff,
  StaffProfile,
  User,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from '../../utils/errors';
import { isValidTimezone } from '../../utils/time';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import { invalidateBookingPageCache } from '../publicBooking/publicBooking.cache';
import type {
  CreateStaffBody,
  ListStaffQuery,
  ReplaceStaffServicesBody,
  UpdateStaffBody,
} from './staff.validation';

const log = createLogger('staff');

/**
 * Enough to recognise a colleague, and no contact details: STAFF_READ is held
 * by the base Staff role, and a rota screen is not a reason to hand every
 * member the workspace address book. Email and phone stay behind MEMBERS_READ.
 */
const STAFF_USER_ATTRIBUTES = ['id', 'firstName', 'lastName', 'avatarUrl'] as const;

const SERVICE_ATTRIBUTES = [
  'id',
  'name',
  'slug',
  'durationMinutes',
  'priceAmount',
  'currency',
  'isActive',
] as const;

export interface StaffActor {
  userId: string;
  email: string;
}

export interface StaffPage {
  rows: StaffProfile[];
  totalItems: number;
}

/**
 * The one place a staff profile is loaded by id.
 *
 * Scoped by `businessId` so a foreign id and a nonexistent id produce the same
 * answer, and left on the paranoid default so a soft-deleted profile is gone as
 * far as the API is concerned.
 */
async function findStaffOrThrow(
  businessId: string,
  staffProfileId: string,
  transaction?: Transaction,
): Promise<StaffProfile> {
  const staff = await StaffProfile.findOne({
    where: { id: staffProfileId, businessId },
    transaction,
  });
  if (!staff) throw new NotFoundError('Staff profile');
  return staff;
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

/** A default location from another workspace must look like one that is absent. */
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

/**
 * Appointments that still need this provider on the calendar.
 *
 * `endsAt` rather than `startsAt`: an appointment running right now still needs
 * the person delivering it.
 */
async function countBlockingAppointments(
  businessId: string,
  staffProfileId: string,
  transaction: Transaction,
): Promise<number> {
  return Appointment.count({
    where: {
      businessId,
      status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
      endsAt: { [Op.gt]: new Date() },
      [Op.or]: [
        { staffProfileId },
        // Collective bookings name their providers only in appointment_staff,
        // so testing the primary column alone would let a profile be deleted
        // out from under a panel that is still on the books.
        //
        // Spelled with the physical column name: Sequelize emits a `$alias.x$`
        // reference verbatim rather than mapping the model attribute to its
        // field, so `staffProfileId` here would generate a column that does not
        // exist.
        { '$staffReservations.staff_profile_id$': staffProfileId },
      ],
    },
    include: [
      { model: AppointmentStaff, as: 'staffReservations', attributes: [], required: false },
    ],
    // The join can match an appointment twice (primary column *and* a
    // reservation row); without this the operator would be told to clear more
    // appointments than exist.
    distinct: true,
    transaction,
  });
}

export async function listStaff(businessId: string, query: ListStaffQuery): Promise<StaffPage> {
  const { rows, count } = await StaffProfile.findAndCountAll({
    where: {
      businessId,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.isBookable !== undefined ? { isBookable: query.isBookable } : {}),
    },
    include: [{ model: User, as: 'user', attributes: [...STAFF_USER_ATTRIBUTES] }],
    // sortOrder is the operator's own arrangement; the name only breaks ties.
    order: [
      ['sortOrder', 'ASC'],
      ['displayName', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

export async function getStaff(businessId: string, staffProfileId: string): Promise<StaffProfile> {
  const staff = await StaffProfile.findOne({
    where: { id: staffProfileId, businessId },
    include: [{ model: User, as: 'user', attributes: [...STAFF_USER_ATTRIBUTES] }],
  });
  if (!staff) throw new NotFoundError('Staff profile');
  return staff;
}

export async function createStaffProfile(
  businessId: string,
  input: CreateStaffBody,
  actor: StaffActor,
  metadata: RequestMetadata,
): Promise<StaffProfile> {
  if (input.timezone !== undefined) assertTimezone(input.timezone);

  return sequelize.transaction(async (transaction) => {
    const business = await Business.findByPk(businessId, {
      attributes: ['id', 'timezone'],
      transaction,
    });
    if (!business) throw new NotFoundError('Workspace');

    // Scoping the membership lookup on businessId is what makes the derived
    // user id safe: a membership from another tenant resolves to nothing.
    const membership = await Membership.findOne({
      where: { id: input.membershipId, businessId },
      include: [
        { model: User, as: 'user', required: true, attributes: ['id', 'firstName', 'lastName'] },
      ],
      transaction,
    });
    if (!membership) throw new NotFoundError('Membership');

    if (membership.status === 'REMOVED') {
      throw new ConflictError(
        'That member has been removed from this workspace and cannot be made bookable.',
      );
    }

    // Derived, never read from the body.
    const userId = membership.userId;

    // Mirrors the partial unique index on (business_id, user_id), which ignores
    // soft-deleted rows — so a returning member can be re-onboarded, but a live
    // duplicate is a conflict rather than a database error surfacing as a 500.
    const duplicate = await StaffProfile.findOne({
      where: { businessId, userId },
      attributes: ['id'],
      transaction,
    });
    if (duplicate) {
      throw new ConflictError(
        'That member already has a staff profile in this workspace.',
        ErrorCode.ALREADY_EXISTS,
      );
    }

    if (input.defaultLocationId) {
      await assertLocationInTenant(businessId, input.defaultLocationId, transaction);
    }

    const user = membership.get('user') as User;
    const displayName = input.displayName ?? `${user.firstName} ${user.lastName}`.trim();

    // A profile with no zone of its own follows the workspace. Falling through
    // to the column default would make it UTC, which is wrong everywhere but
    // one meridian and invisible until slots appear at the wrong hour.
    const timezone = input.timezone ?? business.timezone;

    const staff = await StaffProfile.create(
      {
        businessId,
        userId,
        membershipId: membership.id,
        displayName,
        title: input.title ?? null,
        bio: input.bio ?? null,
        avatarUrl: input.avatarUrl ?? null,
        timezone,
        defaultLocationId: input.defaultLocationId ?? null,
        preBufferMinutes: input.preBufferMinutes ?? null,
        postBufferMinutes: input.postBufferMinutes ?? null,
        minNoticeMinutes: input.minNoticeMinutes ?? null,
        maxDailyAppointments: input.maxDailyAppointments ?? null,
        maxWeeklyAppointments: input.maxWeeklyAppointments ?? null,
        lastAssignedAt: null,
        // Colour, bookability, weight, order and activity fall through to the
        // column defaults when the caller did not choose, so each default is
        // defined in exactly one place.
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.isBookable !== undefined ? { isBookable: input.isBookable } : {}),
        ...(input.assignmentWeight !== undefined
          ? { assignmentWeight: input.assignmentWeight }
          : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.STAFF_CREATED,
        entityType: 'staff_profile',
        entityId: staff.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          membershipId: membership.id,
          userId,
          displayName: staff.displayName,
          timezone: staff.timezone,
          isBookable: staff.isBookable,
        },
      },
      { transaction },
    );

    // A provider the workspace can offer is part of every published page that
    // reaches them through a service they deliver.
    await invalidateBookingPageCache(businessId, transaction);

    log.info({ businessId, staffProfileId: staff.id, userId }, 'staff profile created');
    return staff;
  });
}

export async function updateStaffProfile(
  businessId: string,
  staffProfileId: string,
  input: UpdateStaffBody,
  actor: StaffActor,
  metadata: RequestMetadata,
): Promise<StaffProfile> {
  if (input.timezone !== undefined) assertTimezone(input.timezone);

  return sequelize.transaction(async (transaction) => {
    const staff = await findStaffOrThrow(businessId, staffProfileId, transaction);

    if (input.defaultLocationId) {
      await assertLocationInTenant(businessId, input.defaultLocationId, transaction);
    }

    const before = {
      displayName: staff.displayName,
      timezone: staff.timezone,
      isBookable: staff.isBookable,
      isActive: staff.isActive,
      assignmentWeight: staff.assignmentWeight,
    };

    await staff.update(
      {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.defaultLocationId !== undefined
          ? { defaultLocationId: input.defaultLocationId }
          : {}),
        ...(input.isBookable !== undefined ? { isBookable: input.isBookable } : {}),
        ...(input.preBufferMinutes !== undefined
          ? { preBufferMinutes: input.preBufferMinutes }
          : {}),
        ...(input.postBufferMinutes !== undefined
          ? { postBufferMinutes: input.postBufferMinutes }
          : {}),
        ...(input.minNoticeMinutes !== undefined
          ? { minNoticeMinutes: input.minNoticeMinutes }
          : {}),
        ...(input.maxDailyAppointments !== undefined
          ? { maxDailyAppointments: input.maxDailyAppointments }
          : {}),
        ...(input.maxWeeklyAppointments !== undefined
          ? { maxWeeklyAppointments: input.maxWeeklyAppointments }
          : {}),
        ...(input.assignmentWeight !== undefined
          ? { assignmentWeight: input.assignmentWeight }
          : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.STAFF_UPDATED,
        entityType: 'staff_profile',
        entityId: staff.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          changed: Object.keys(input),
          before,
          after: {
            displayName: staff.displayName,
            timezone: staff.timezone,
            isBookable: staff.isBookable,
            isActive: staff.isActive,
            assignmentWeight: staff.assignmentWeight,
          },
        },
      },
      { transaction },
    );

    // `displayName`, `isBookable` and `isActive` are all quoted on the public
    // page; a provider turned off has to stop being offered now, not when the
    // TTL happens to lapse.
    await invalidateBookingPageCache(businessId, transaction);

    return staff;
  });
}

export async function deleteStaffProfile(
  businessId: string,
  staffProfileId: string,
  actor: StaffActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const staff = await findStaffOrThrow(businessId, staffProfileId, transaction);

    const blocking = await countBlockingAppointments(businessId, staff.id, transaction);
    if (blocking > 0) {
      throw new ConflictError(
        `This staff member still has ${blocking} upcoming appointment${blocking === 1 ? '' : 's'}. ` +
          'Reassign or cancel them, or set isBookable to false instead.',
        ErrorCode.CONFLICT,
        { activeAppointments: blocking },
      );
    }

    // Soft delete (the model is paranoid): past appointments keep resolving the
    // person who delivered them, and the partial unique index releases
    // (business_id, user_id) so the same member can be re-onboarded later.
    await staff.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.STAFF_DELETED,
        entityType: 'staff_profile',
        entityId: staff.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { displayName: staff.displayName, membershipId: staff.membershipId },
      },
      { transaction },
    );

    await invalidateBookingPageCache(businessId, transaction);

    log.info({ businessId, staffProfileId: staff.id }, 'staff profile deleted');
  });
}

/**
 * The services this staff member may deliver.
 *
 * The include is `required: true` and scoped on businessId, so it doubles as a
 * second tenant check on the far side of a join table that has no tenant column
 * of its own.
 */
async function loadStaffServices(
  businessId: string,
  staffProfileId: string,
  transaction?: Transaction,
): Promise<ServiceStaff[]> {
  return ServiceStaff.findAll({
    where: { staffProfileId },
    include: [
      {
        model: Service,
        as: 'service',
        required: true,
        where: { businessId },
        attributes: [...SERVICE_ATTRIBUTES],
      },
    ],
    order: [
      ['priority', 'ASC'],
      ['createdAt', 'ASC'],
    ],
    transaction,
  });
}

export async function listStaffServices(
  businessId: string,
  staffProfileId: string,
): Promise<ServiceStaff[]> {
  const staff = await findStaffOrThrow(businessId, staffProfileId);
  return loadStaffServices(businessId, staff.id);
}

export async function replaceStaffServices(
  businessId: string,
  staffProfileId: string,
  input: ReplaceStaffServicesBody,
  actor: StaffActor,
  metadata: RequestMetadata,
): Promise<ServiceStaff[]> {
  const desired = [...new Set(input.serviceIds)];

  return sequelize.transaction(async (transaction) => {
    const staff = await findStaffOrThrow(businessId, staffProfileId, transaction);

    if (desired.length > 0) {
      const known = await Service.count({
        where: { id: { [Op.in]: desired }, businessId },
        transaction,
      });
      // A service from another workspace and a service that does not exist get
      // the same answer, so this endpoint cannot confirm foreign service ids.
      if (known !== desired.length) throw new NotFoundError('Service');
    }

    // Anchored on a staff profile already proven to be in this tenant, which is
    // what makes this read — and the three writes below — tenant-safe despite
    // service_staff having no business_id.
    const existing = await ServiceStaff.findAll({
      where: { staffProfileId: staff.id },
      transaction,
    });

    const existingIds = new Set(existing.map((row) => row.serviceId));
    const desiredIds = new Set(desired);

    const removed = existing
      .filter((row) => !desiredIds.has(row.serviceId))
      .map((row) => row.serviceId);
    const added = desired.filter((serviceId) => !existingIds.has(serviceId));
    // Pairings on both sides of the diff are left in place so their duration and
    // price overrides survive a set replacement; a paused one is put back into
    // rotation because the caller has just declared this member delivers it.
    const reactivated = existing
      .filter((row) => desiredIds.has(row.serviceId) && !row.isActive)
      .map((row) => row.serviceId);

    if (removed.length > 0) {
      // Hard delete: service_staff has no deleted_at, and the unique index on
      // (service_id, staff_profile_id) needs the row gone before the pairing
      // can ever be assigned again.
      await ServiceStaff.destroy({
        where: { staffProfileId: staff.id, serviceId: { [Op.in]: removed } },
        transaction,
      });
    }

    if (added.length > 0) {
      await ServiceStaff.bulkCreate(
        added.map((serviceId) => ({
          serviceId,
          staffProfileId: staff.id,
          durationMinutesOverride: null,
          priceAmountOverride: null,
        })),
        { transaction },
      );
    }

    if (reactivated.length > 0) {
      await ServiceStaff.update(
        { isActive: true },
        {
          where: { staffProfileId: staff.id, serviceId: { [Op.in]: reactivated } },
          transaction,
        },
      );
    }

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        // No STAFF_SERVICES_* constant exists; STAFF_UPDATED keeps the entity
        // type honest and the metadata says what actually changed.
        action: AuditActions.STAFF_UPDATED,
        entityType: 'staff_profile',
        entityId: staff.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          change: 'services_replaced',
          added,
          removed,
          reactivated,
          totalServices: desired.length,
        },
      },
      { transaction },
    );

    log.info(
      { businessId, staffProfileId: staff.id, added: added.length, removed: removed.length },
      'staff services replaced',
    );

    return loadStaffServices(businessId, staff.id, transaction);
  });
}
