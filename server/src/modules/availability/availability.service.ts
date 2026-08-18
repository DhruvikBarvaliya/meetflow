/**
 * Availability — when a workspace, a site, a person or a resource can be booked.
 *
 * Five tables answer that question from two different angles, and the split is
 * load-bearing:
 *
 *  - `business_hours` and `staff_availability_rules` are repeating wall-clock
 *    rules; `availability_overrides` and `holidays` are calendar-day exceptions
 *    to them. All four are resolved against an IANA zone at the moment they are
 *    used, which is what keeps "09:00" meaning 09:00 across a DST change.
 *  - `blackout_periods` are absolute instants, so they need no zone at all.
 *
 * Three rules govern every function here:
 *
 *  1. `businessId` is the first parameter and always comes from the caller's
 *     proven membership. A row belonging to another workspace is answered with
 *     404, never 403, so these endpoints cannot be used to probe which staff,
 *     location or resource ids exist.
 *  2. `availability:manage:own` is narrower than `availability:manage`, not
 *     additional. Whether a request is "own" depends on the row it touches, so
 *     it cannot be decided on the router and is enforced here instead.
 *  3. Removing time is the only kind of availability change that can strand a
 *     booking, so that — and only that — is checked against the calendar first.
 */
import { Op, UniqueConstraintError, type Includeable, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  AppointmentResource,
  AppointmentStaff,
  AvailabilityOverride,
  BlackoutPeriod,
  Business,
  BusinessHours,
  Holiday,
  Location,
  Resource,
  StaffAvailabilityRule,
  StaffProfile,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import { ConflictError, ErrorCode, ForbiddenError, NotFoundError } from '../../utils/errors';
import {
  endOfDayInZone,
  isValidTimezone,
  startOfDayInZone,
  wallClockToInstant,
} from '../../utils/time';
import { SocketEvents, emitToWorkspace } from '../../sockets';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import { PERMISSIONS } from '../auth/permissions';
import type {
  CreateBlackoutBody,
  CreateHolidayBody,
  CreateOverrideBody,
  ListBlackoutsQuery,
  ListBusinessHoursQuery,
  ListHolidaysQuery,
  ListOverridesQuery,
  ListStaffRulesQuery,
  ReplaceBusinessHoursBody,
  ReplaceStaffRulesBody,
} from './availability.validation';

const log = createLogger('availability');

export interface AvailabilityActor {
  userId: string;
  email: string;
  /** The caller's own bookable identity, when they have one. */
  staffProfileId: string | null;
  /** True when the caller may edit anyone's availability, not only their own. */
  canManageAll: boolean;
}

export interface AvailabilityPage<T> {
  rows: T[];
  totalItems: number;
}

/** The entity a restriction applies to. All-null means the whole workspace. */
interface AvailabilityTarget {
  staffProfileId: string | null;
  locationId: string | null;
  resourceId: string | null;
}

interface Span {
  start: Date;
  end: Date;
}

// ---------------------------------------------------------------------------
// Authorisation and tenant scoping
// ---------------------------------------------------------------------------

/**
 * Narrows a caller holding only `availability:manage:own`.
 *
 * A row with no staff target is workspace-wide, so it is never "their own" —
 * which is why a null target fails closed rather than being waved through.
 */
function assertMayManageStaff(actor: AvailabilityActor, staffProfileId: string | null): void {
  if (actor.canManageAll) return;
  if (staffProfileId !== null && staffProfileId === actor.staffProfileId) return;
  throw new ForbiddenError('You may only change your own availability.', undefined, {
    required: [PERMISSIONS.AVAILABILITY_MANAGE],
  });
}

async function findStaffOrThrow(
  businessId: string,
  staffProfileId: string,
  transaction?: Transaction,
): Promise<StaffProfile> {
  const staff = await StaffProfile.findOne({
    where: { id: staffProfileId, businessId },
    attributes: ['id', 'displayName', 'timezone'],
    transaction,
  });
  if (!staff) throw new NotFoundError('Staff profile');
  return staff;
}

async function findLocationOrThrow(
  businessId: string,
  locationId: string,
  transaction?: Transaction,
): Promise<Location> {
  const location = await Location.findOne({
    where: { id: locationId, businessId },
    attributes: ['id', 'name', 'timezone'],
    transaction,
  });
  if (!location) throw new NotFoundError('Location');
  return location;
}

async function assertResourceInTenant(
  businessId: string,
  resourceId: string,
  transaction?: Transaction,
): Promise<void> {
  const resource = await Resource.findOne({
    where: { id: resourceId, businessId },
    attributes: ['id'],
    transaction,
  });
  if (!resource) throw new NotFoundError('Resource');
}

/** One query for a whole payload's worth of locations, all tenant-scoped. */
async function assertLocationsInTenant(
  businessId: string,
  locationIds: readonly string[],
  transaction: Transaction,
): Promise<void> {
  const distinct = [...new Set(locationIds)];
  if (distinct.length === 0) return;
  const known = await Location.count({
    where: { id: { [Op.in]: distinct }, businessId },
    transaction,
  });
  // A location from another workspace and one that does not exist get the same
  // answer, so this endpoint cannot confirm foreign location ids.
  if (known !== distinct.length) throw new NotFoundError('Location');
}

/**
 * Two concurrent writes both passed their own in-payload checks and only the
 * unique index settled it. Translating the violation keeps the loser a 409
 * instead of a 500.
 */
function rethrowAsConflict(error: unknown, message: string): never {
  if (error instanceof UniqueConstraintError) {
    throw new ConflictError(message, ErrorCode.ALREADY_EXISTS);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Clash detection against the calendar
// ---------------------------------------------------------------------------

/**
 * The zone a wall-clock exception is read in: the member's own clock first,
 * then the site's, then the workspace's.
 *
 * An invalid stored identifier is skipped rather than used, because
 * `wallClockToInstant` throws on an unknown zone — a stale row must not turn a
 * routine leave request into a 500.
 */
function resolveZone(candidates: ReadonlyArray<string | undefined>): string {
  return (
    candidates.find((zone): zone is string => zone !== undefined && isValidTimezone(zone)) ?? 'UTC'
  );
}

/**
 * The instants an override covers. A null window is the whole local day, which
 * is 23, 24 or 25 real hours depending on where the DST boundary falls — hence
 * resolving both ends through the zone rather than adding 1440 minutes.
 */
function spanOfOverride(
  override: { date: string; startMinute: number | null; endMinute: number | null },
  zone: string,
): Span {
  const { startMinute, endMinute } = override;
  if (startMinute === null || endMinute === null) {
    return {
      start: startOfDayInZone(override.date, zone),
      end: endOfDayInZone(override.date, zone),
    };
  }
  return {
    start: wallClockToInstant(override.date, startMinute, zone),
    end: wallClockToInstant(override.date, endMinute, zone),
  };
}

/**
 * Appointments that would be stranded inside a span.
 *
 * Measured on `startsAt`/`endsAt` rather than the buffered footprint: the
 * operator is being told which bookings clash, and those are the times they see
 * on the calendar.
 */
async function countBookedAppointments(
  businessId: string,
  target: AvailabilityTarget,
  span: Span,
  transaction: Transaction,
): Promise<number> {
  const include: Includeable[] = [];
  if (target.staffProfileId !== null) {
    include.push({
      model: AppointmentStaff,
      as: 'staffReservations',
      attributes: [],
      required: false,
    });
  }
  if (target.resourceId !== null) {
    include.push({
      model: AppointmentResource,
      as: 'resourceReservations',
      attributes: [],
      required: false,
    });
  }

  return Appointment.count({
    where: {
      businessId,
      status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
      // Half-open overlap: a booking that ends exactly when the block starts is
      // not caught by it, matching the `[)` semantics used everywhere else.
      startsAt: { [Op.lt]: span.end },
      endsAt: { [Op.gt]: span.start },
      ...(target.locationId !== null ? { locationId: target.locationId } : {}),
      ...(target.resourceId !== null
        ? { '$resourceReservations.resourceId$': target.resourceId }
        : {}),
      ...(target.staffProfileId !== null
        ? {
            [Op.or]: [
              { staffProfileId: target.staffProfileId },
              // Collective bookings name their providers only in
              // appointment_staff, so testing the primary column alone would
              // miss a panel that is still on the books.
              { '$staffReservations.staffProfileId$': target.staffProfileId },
            ],
          }
        : {}),
    },
    include,
    // The join can match one appointment twice (primary column *and* a
    // reservation row); without this the operator is told to clear more
    // bookings than exist.
    distinct: include.length > 0,
    transaction,
  });
}

async function assertNothingBooked(
  businessId: string,
  target: AvailabilityTarget,
  span: Span,
  subject: string,
  transaction: Transaction,
): Promise<void> {
  const blocking = await countBookedAppointments(businessId, target, span, transaction);
  if (blocking === 0) return;
  throw new ConflictError(
    `${blocking} appointment${blocking === 1 ? ' is' : 's are'} already booked inside that ` +
      `${subject}. Move or cancel ${blocking === 1 ? 'it' : 'them'} first.`,
    ErrorCode.CONFLICT,
    { activeAppointments: blocking },
  );
}

function announce(businessId: string, payload: Record<string, unknown>): void {
  emitToWorkspace(businessId, SocketEvents.availabilityUpdated, payload);
}

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

function loadBusinessHours(
  businessId: string,
  locationId: string | null,
  transaction?: Transaction,
): Promise<BusinessHours[]> {
  return BusinessHours.findAll({
    where: { businessId, locationId },
    order: [
      ['dayOfWeek', 'ASC'],
      ['startMinute', 'ASC'],
    ],
    transaction,
  });
}

export async function listBusinessHours(
  businessId: string,
  query: ListBusinessHoursQuery,
): Promise<AvailabilityPage<BusinessHours>> {
  const { rows, count } = await BusinessHours.findAndCountAll({
    where: {
      businessId,
      // `null` becomes `location_id IS NULL`, which is the business-wide set.
      locationId: query.locationId ?? null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    },
    order: [
      ['dayOfWeek', 'ASC'],
      ['startMinute', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

/**
 * Replaces the whole weekly set for one scope.
 *
 * Delete-then-insert rather than a diff: the caller has sent the week they want
 * to end up with, and rebuilding it is the only way an empty array can mean
 * "closed all week" instead of "change nothing".
 */
export async function replaceBusinessHours(
  businessId: string,
  input: ReplaceBusinessHoursBody,
  actor: AvailabilityActor,
  metadata: RequestMetadata,
): Promise<BusinessHours[]> {
  const rows = await sequelize.transaction(async (transaction) => {
    if (input.locationId !== null) {
      await findLocationOrThrow(businessId, input.locationId, transaction);
    }

    const removed = await BusinessHours.destroy({
      where: { businessId, locationId: input.locationId },
      transaction,
    });

    if (input.hours.length > 0) {
      try {
        await BusinessHours.bulkCreate(
          input.hours.map((entry) => ({
            businessId,
            locationId: input.locationId,
            dayOfWeek: entry.dayOfWeek,
            startMinute: entry.startMinute,
            endMinute: entry.endMinute,
            isActive: entry.isActive,
          })),
          { transaction },
        );
      } catch (error) {
        rethrowAsConflict(error, 'Those opening hours were changed by someone else. Try again.');
      }
    }

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.AVAILABILITY_UPDATED,
        entityType: 'business_hours',
        // The set is identified by the site it belongs to; NULL is the
        // business-wide week.
        entityId: input.locationId,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          change: 'business_hours_replaced',
          locationId: input.locationId,
          removed,
          created: input.hours.length,
        },
      },
      { transaction },
    );

    return loadBusinessHours(businessId, input.locationId, transaction);
  });

  // After the commit: a client told to re-read must not race the transaction.
  announce(businessId, {
    change: 'business_hours',
    locationId: input.locationId,
    windows: rows.length,
  });
  log.info(
    { businessId, locationId: input.locationId, windows: rows.length },
    'business hours replaced',
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Staff availability rules
// ---------------------------------------------------------------------------

function loadStaffRules(
  businessId: string,
  staffProfileId: string,
  transaction?: Transaction,
): Promise<StaffAvailabilityRule[]> {
  return StaffAvailabilityRule.findAll({
    where: { businessId, staffProfileId },
    order: [
      ['dayOfWeek', 'ASC'],
      ['startMinute', 'ASC'],
    ],
    transaction,
  });
}

export async function listStaffRules(
  businessId: string,
  staffProfileId: string,
  query: ListStaffRulesQuery,
): Promise<AvailabilityPage<StaffAvailabilityRule>> {
  // Checked first so a profile from another workspace answers 404 rather than
  // an empty page, which would confirm the id is unused rather than foreign.
  await findStaffOrThrow(businessId, staffProfileId);

  const { rows, count } = await StaffAvailabilityRule.findAndCountAll({
    where: {
      businessId,
      staffProfileId,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    },
    order: [
      ['dayOfWeek', 'ASC'],
      ['startMinute', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

export async function replaceStaffRules(
  businessId: string,
  staffProfileId: string,
  input: ReplaceStaffRulesBody,
  actor: AvailabilityActor,
  metadata: RequestMetadata,
): Promise<StaffAvailabilityRule[]> {
  assertMayManageStaff(actor, staffProfileId);

  const rows = await sequelize.transaction(async (transaction) => {
    const staff = await findStaffOrThrow(businessId, staffProfileId, transaction);

    await assertLocationsInTenant(
      businessId,
      input.rules
        .map((rule) => rule.locationId)
        .filter((locationId): locationId is string => locationId !== null),
      transaction,
    );

    const removed = await StaffAvailabilityRule.destroy({
      where: { businessId, staffProfileId: staff.id },
      transaction,
    });

    if (input.rules.length > 0) {
      await StaffAvailabilityRule.bulkCreate(
        input.rules.map((rule) => ({
          businessId,
          staffProfileId: staff.id,
          locationId: rule.locationId,
          dayOfWeek: rule.dayOfWeek,
          startMinute: rule.startMinute,
          endMinute: rule.endMinute,
          effectiveFrom: rule.effectiveFrom,
          effectiveTo: rule.effectiveTo,
          isActive: rule.isActive,
        })),
        { transaction },
      );
    }

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.AVAILABILITY_UPDATED,
        entityType: 'staff_availability_rules',
        entityId: staff.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          change: 'staff_rules_replaced',
          staffProfileId: staff.id,
          removed,
          created: input.rules.length,
          // Recorded because a member editing their own rota and a manager
          // editing it for them are different events on the same row.
          editedOwn: actor.staffProfileId === staff.id,
        },
      },
      { transaction },
    );

    return loadStaffRules(businessId, staff.id, transaction);
  });

  announce(businessId, {
    change: 'staff_rules',
    staffProfileId,
    windows: rows.length,
  });
  log.info({ businessId, staffProfileId, windows: rows.length }, 'staff availability replaced');
  return rows;
}

// ---------------------------------------------------------------------------
// Availability overrides
// ---------------------------------------------------------------------------

export async function listOverrides(
  businessId: string,
  query: ListOverridesQuery,
): Promise<AvailabilityPage<AvailabilityOverride>> {
  const dateRange = {
    ...(query.from !== undefined ? { [Op.gte]: query.from } : {}),
    ...(query.to !== undefined ? { [Op.lte]: query.to } : {}),
  };

  const { rows, count } = await AvailabilityOverride.findAndCountAll({
    where: {
      businessId,
      ...(query.staffProfileId !== undefined ? { staffProfileId: query.staffProfileId } : {}),
      ...(query.scope !== undefined ? { scope: query.scope } : {}),
      ...(query.from !== undefined || query.to !== undefined ? { date: dateRange } : {}),
    },
    order: [
      ['date', 'ASC'],
      ['createdAt', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

export async function createOverride(
  businessId: string,
  input: CreateOverrideBody,
  actor: AvailabilityActor,
  metadata: RequestMetadata,
): Promise<AvailabilityOverride> {
  assertMayManageStaff(actor, input.staffProfileId);

  const override = await sequelize.transaction(async (transaction) => {
    const staff =
      input.staffProfileId !== null
        ? await findStaffOrThrow(businessId, input.staffProfileId, transaction)
        : null;
    const location =
      input.locationId !== null
        ? await findLocationOrThrow(businessId, input.locationId, transaction)
        : null;
    if (input.resourceId !== null) {
      await assertResourceInTenant(businessId, input.resourceId, transaction);
    }

    // Only a removal can strand a booking; an added window frees time and can
    // never conflict with what is already on the calendar.
    if (!input.isAvailable) {
      const business = await Business.findByPk(businessId, {
        attributes: ['id', 'timezone'],
        transaction,
      });
      if (!business) throw new NotFoundError('Workspace');

      const zone = resolveZone([staff?.timezone, location?.timezone, business.timezone]);
      await assertNothingBooked(
        businessId,
        input,
        spanOfOverride(input, zone),
        input.startMinute === null ? 'day' : 'window',
        transaction,
      );
    }

    const row = await AvailabilityOverride.create(
      {
        businessId,
        scope: input.scope,
        staffProfileId: input.staffProfileId,
        locationId: input.locationId,
        resourceId: input.resourceId,
        date: input.date,
        isAvailable: input.isAvailable,
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        reason: input.reason,
        note: input.note,
        createdByUserId: actor.userId,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.AVAILABILITY_OVERRIDE_CREATED,
        entityType: 'availability_override',
        entityId: row.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          scope: row.scope,
          staffProfileId: row.staffProfileId,
          locationId: row.locationId,
          resourceId: row.resourceId,
          date: row.date,
          isAvailable: row.isAvailable,
          reason: row.reason,
          editedOwn: actor.staffProfileId !== null && actor.staffProfileId === row.staffProfileId,
        },
      },
      { transaction },
    );

    return row;
  });

  announce(businessId, {
    change: 'override_created',
    overrideId: override.id,
    scope: override.scope,
    staffProfileId: override.staffProfileId,
    locationId: override.locationId,
    resourceId: override.resourceId,
    date: override.date,
    isAvailable: override.isAvailable,
  });
  log.info(
    { businessId, overrideId: override.id, scope: override.scope, date: override.date },
    'availability override created',
  );
  return override;
}

export async function deleteOverride(
  businessId: string,
  overrideId: string,
  actor: AvailabilityActor,
  metadata: RequestMetadata,
): Promise<void> {
  const removed = await sequelize.transaction(async (transaction) => {
    const override = await AvailabilityOverride.findOne({
      where: { id: overrideId, businessId },
      transaction,
    });
    if (!override) throw new NotFoundError('Availability override');

    assertMayManageStaff(actor, override.staffProfileId);

    // Hard delete: the table has no deleted_at, and a withdrawn exception would
    // still have to be filtered out of every availability query if it lingered.
    // Nothing references the row — lifting a restriction only ever frees time,
    // so no booking can be stranded by its removal.
    await override.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.AVAILABILITY_OVERRIDE_DELETED,
        entityType: 'availability_override',
        entityId: override.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          scope: override.scope,
          staffProfileId: override.staffProfileId,
          locationId: override.locationId,
          resourceId: override.resourceId,
          date: override.date,
          isAvailable: override.isAvailable,
        },
      },
      { transaction },
    );

    return override;
  });

  announce(businessId, {
    change: 'override_deleted',
    overrideId: removed.id,
    scope: removed.scope,
    staffProfileId: removed.staffProfileId,
    date: removed.date,
  });
  log.info({ businessId, overrideId: removed.id }, 'availability override deleted');
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export async function listHolidays(
  businessId: string,
  query: ListHolidaysQuery,
): Promise<AvailabilityPage<Holiday>> {
  const dateRange = {
    ...(query.from !== undefined ? { [Op.gte]: query.from } : {}),
    ...(query.to !== undefined ? { [Op.lte]: query.to } : {}),
  };
  const hasRange = query.from !== undefined || query.to !== undefined;

  const { rows, count } = await Holiday.findAndCountAll({
    where: {
      businessId,
      ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      // A recurring holiday stores only its first observed year, so filtering
      // on the stored date alone would hide the very rows that repeat into the
      // window being asked about.
      ...(hasRange ? { [Op.or]: [{ date: dateRange }, { isRecurringAnnually: true }] } : {}),
    },
    order: [
      ['date', 'ASC'],
      ['name', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

export async function createHoliday(
  businessId: string,
  input: CreateHolidayBody,
  actor: AvailabilityActor,
  metadata: RequestMetadata,
): Promise<Holiday> {
  const holiday = await sequelize.transaction(async (transaction) => {
    if (input.locationId !== null) {
      await findLocationOrThrow(businessId, input.locationId, transaction);
    }

    // The catch mirrors holidays_unique on (business, location, date, name):
    // the same day may be named twice only under different labels.
    const row = await Holiday.create(
      {
        businessId,
        locationId: input.locationId,
        name: input.name,
        date: input.date,
        isRecurringAnnually: input.isRecurringAnnually,
        closesBusiness: input.closesBusiness,
        isActive: input.isActive,
      },
      { transaction },
    ).catch((error: unknown) =>
      rethrowAsConflict(error, 'That holiday is already in the calendar for that date.'),
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.HOLIDAY_CREATED,
        entityType: 'holiday',
        entityId: row.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          name: row.name,
          date: row.date,
          locationId: row.locationId,
          closesBusiness: row.closesBusiness,
          isRecurringAnnually: row.isRecurringAnnually,
        },
      },
      { transaction },
    );

    return row;
  });

  announce(businessId, {
    change: 'holiday_created',
    holidayId: holiday.id,
    date: holiday.date,
    locationId: holiday.locationId,
    closesBusiness: holiday.closesBusiness,
  });
  log.info({ businessId, holidayId: holiday.id, date: holiday.date }, 'holiday created');
  return holiday;
}

export async function deleteHoliday(
  businessId: string,
  holidayId: string,
  actor: AvailabilityActor,
  metadata: RequestMetadata,
): Promise<void> {
  const removed = await sequelize.transaction(async (transaction) => {
    const holiday = await Holiday.findOne({ where: { id: holidayId, businessId }, transaction });
    if (!holiday) throw new NotFoundError('Holiday');

    // Hard delete: the table has no deleted_at, and the unique index on
    // (business, location, date, name) must release the day for reuse. Nothing
    // references the row, and removing a closure only ever frees time.
    await holiday.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.HOLIDAY_DELETED,
        entityType: 'holiday',
        entityId: holiday.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { name: holiday.name, date: holiday.date, locationId: holiday.locationId },
      },
      { transaction },
    );

    return holiday;
  });

  announce(businessId, {
    change: 'holiday_deleted',
    holidayId: removed.id,
    date: removed.date,
    locationId: removed.locationId,
  });
  log.info({ businessId, holidayId: removed.id }, 'holiday deleted');
}

// ---------------------------------------------------------------------------
// Blackout periods
// ---------------------------------------------------------------------------

export async function listBlackouts(
  businessId: string,
  query: ListBlackoutsQuery,
): Promise<AvailabilityPage<BlackoutPeriod>> {
  const { rows, count } = await BlackoutPeriod.findAndCountAll({
    where: {
      businessId,
      ...(query.scope !== undefined ? { scope: query.scope } : {}),
      ...(query.staffProfileId !== undefined ? { staffProfileId: query.staffProfileId } : {}),
      ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
      ...(query.resourceId !== undefined ? { resourceId: query.resourceId } : {}),
      // Overlap, not containment: a blackout that started last week and runs
      // through the window being asked about is exactly what the caller needs.
      ...(query.from !== undefined ? { endsAt: { [Op.gt]: query.from } } : {}),
      ...(query.to !== undefined ? { startsAt: { [Op.lt]: query.to } } : {}),
    },
    order: [['startsAt', 'ASC']],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

export async function createBlackout(
  businessId: string,
  input: CreateBlackoutBody,
  actor: AvailabilityActor,
  metadata: RequestMetadata,
): Promise<BlackoutPeriod> {
  const blackout = await sequelize.transaction(async (transaction) => {
    if (input.staffProfileId !== null) {
      await findStaffOrThrow(businessId, input.staffProfileId, transaction);
    }
    if (input.locationId !== null) {
      await findLocationOrThrow(businessId, input.locationId, transaction);
    }
    if (input.resourceId !== null) {
      await assertResourceInTenant(businessId, input.resourceId, transaction);
    }

    // A blackout always removes time, so it is always checked — and needs no
    // zone, because its bounds are already instants.
    await assertNothingBooked(
      businessId,
      input,
      { start: input.startsAt, end: input.endsAt },
      'blackout',
      transaction,
    );

    const row = await BlackoutPeriod.create(
      {
        businessId,
        scope: input.scope,
        staffProfileId: input.staffProfileId,
        locationId: input.locationId,
        resourceId: input.resourceId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason,
        note: input.note,
        createdByUserId: actor.userId,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.BLACKOUT_CREATED,
        entityType: 'blackout_period',
        entityId: row.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          scope: row.scope,
          staffProfileId: row.staffProfileId,
          locationId: row.locationId,
          resourceId: row.resourceId,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          reason: row.reason,
        },
      },
      { transaction },
    );

    return row;
  });

  announce(businessId, {
    change: 'blackout_created',
    blackoutId: blackout.id,
    scope: blackout.scope,
    staffProfileId: blackout.staffProfileId,
    locationId: blackout.locationId,
    resourceId: blackout.resourceId,
    startsAt: blackout.startsAt,
    endsAt: blackout.endsAt,
  });
  log.info(
    { businessId, blackoutId: blackout.id, scope: blackout.scope },
    'blackout period created',
  );
  return blackout;
}

export async function deleteBlackout(
  businessId: string,
  blackoutId: string,
  actor: AvailabilityActor,
  metadata: RequestMetadata,
): Promise<void> {
  const removed = await sequelize.transaction(async (transaction) => {
    const blackout = await BlackoutPeriod.findOne({
      where: { id: blackoutId, businessId },
      transaction,
    });
    if (!blackout) throw new NotFoundError('Blackout period');

    // Hard delete: the table has no deleted_at, and a soft-deleted span would
    // still have to be excluded from every overlap query the scheduling engine
    // runs. Nothing references the row; lifting it only ever frees time.
    await blackout.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.BLACKOUT_DELETED,
        entityType: 'blackout_period',
        entityId: blackout.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          scope: blackout.scope,
          staffProfileId: blackout.staffProfileId,
          locationId: blackout.locationId,
          resourceId: blackout.resourceId,
          startsAt: blackout.startsAt,
          endsAt: blackout.endsAt,
        },
      },
      { transaction },
    );

    return blackout;
  });

  announce(businessId, {
    change: 'blackout_deleted',
    blackoutId: removed.id,
    scope: removed.scope,
    staffProfileId: removed.staffProfileId,
    startsAt: removed.startsAt,
    endsAt: removed.endsAt,
  });
  log.info({ businessId, blackoutId: removed.id }, 'blackout period deleted');
}
