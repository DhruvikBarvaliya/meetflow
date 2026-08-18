/**
 * Locations — the places, physical or otherwise, where appointments happen.
 *
 * Two rules shape every function here:
 *
 *  1. `businessId` comes from the caller's proven membership and is the first
 *     parameter of every function. A row belonging to another workspace is
 *     answered with 404, never 403, so these endpoints cannot be used to probe
 *     which location ids exist.
 *  2. A location carries its own IANA zone. A chain resolves each branch's day
 *     against the branch's clock, so the zone is validated here as well as at
 *     the HTTP boundary — the column default (`UTC`) is a storage fallback, not
 *     a scheduling decision.
 */
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import { Appointment, Business, Location } from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import type { LocationType } from '../../database/models/Location';
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from '../../utils/errors';
import { slugify, uniqueSlug } from '../../utils/ids';
import { isValidTimezone } from '../../utils/time';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import type {
  CreateLocationBody,
  ListLocationsQuery,
  UpdateLocationBody,
} from './locations.validation';

const log = createLogger('locations');

export interface LocationActor {
  userId: string;
  email: string;
}

export interface LocationPage {
  rows: Location[];
  totalItems: number;
}

/**
 * The one place a location is loaded by id.
 *
 * Scoped by `businessId` so a foreign id and a nonexistent id produce the same
 * answer, and left on the paranoid default so a soft-deleted location is gone
 * as far as the API is concerned.
 */
async function findLocationOrThrow(
  businessId: string,
  locationId: string,
  transaction?: Transaction,
): Promise<Location> {
  const location = await Location.findOne({
    where: { id: locationId, businessId },
    transaction,
  });
  if (!location) throw new NotFoundError('Location');
  return location;
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
 * A static room URL only means something for a VIRTUAL location; on any other
 * type it would be stored, never rendered, and eventually emailed to a customer
 * standing outside a physical door.
 */
function assertVirtualUrlMatchesType(type: LocationType, virtualMeetingUrl: string | null): void {
  if (virtualMeetingUrl !== null && type !== 'VIRTUAL') {
    throw new ValidationError('Only a VIRTUAL location can carry a meeting URL.', [
      { field: 'virtualMeetingUrl', message: `A ${type} location has no meeting room.` },
    ]);
  }
}

/**
 * Slug collision test, scoped to the workspace.
 *
 * The unique index is partial (`WHERE deleted_at IS NULL`), so the default
 * paranoid scope is deliberate: a soft-deleted branch must not hold its slug
 * hostage against the one that replaces it.
 */
async function slugTaken(
  businessId: string,
  candidate: string,
  options: { transaction: Transaction; excludeId?: string },
): Promise<boolean> {
  const clash = await Location.findOne({
    where: {
      businessId,
      slug: candidate,
      ...(options.excludeId ? { id: { [Op.ne]: options.excludeId } } : {}),
    },
    attributes: ['id'],
    transaction: options.transaction,
  });
  return clash !== null;
}

/**
 * Derives a free slug from `requested` when given, otherwise from the name.
 *
 * A caller-chosen slug that is already taken is a conflict rather than a silent
 * rename: their booking links would otherwise point at a slug they never asked
 * for. A slug derived from the name may safely gain a numeric suffix.
 */
async function resolveSlug(
  businessId: string,
  requested: string | undefined,
  fallback: string,
  transaction: Transaction,
  excludeId?: string,
): Promise<string> {
  const slug = await uniqueSlug(requested ?? fallback, (candidate) =>
    slugTaken(businessId, candidate, { transaction, excludeId }),
  );

  if (requested !== undefined && slug !== slugify(requested)) {
    throw new ConflictError(
      'A location with that slug already exists in this workspace.',
      ErrorCode.ALREADY_EXISTS,
    );
  }
  return slug;
}

export async function listLocations(
  businessId: string,
  query: ListLocationsQuery,
): Promise<LocationPage> {
  const { rows, count } = await Location.findAndCountAll({
    where: {
      businessId,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
    },
    // sortOrder is the operator's own arrangement; name only breaks ties.
    order: [
      ['sortOrder', 'ASC'],
      ['name', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

export async function getLocation(businessId: string, locationId: string): Promise<Location> {
  return findLocationOrThrow(businessId, locationId);
}

export async function createLocation(
  businessId: string,
  input: CreateLocationBody,
  actor: LocationActor,
  metadata: RequestMetadata,
): Promise<Location> {
  if (input.timezone !== undefined) assertTimezone(input.timezone);

  const virtualMeetingUrl = input.virtualMeetingUrl ?? null;
  assertVirtualUrlMatchesType(input.type, virtualMeetingUrl);

  return sequelize.transaction(async (transaction) => {
    // A branch with no zone of its own follows head office. Falling through to
    // the column default would make it UTC, which is wrong everywhere but one
    // meridian and invisible until slots start appearing at the wrong hour.
    const business = await Business.findByPk(businessId, {
      attributes: ['id', 'timezone'],
      transaction,
    });
    if (!business) throw new NotFoundError('Workspace');

    const slug = await resolveSlug(businessId, input.slug, input.name, transaction);
    const timezone = input.timezone ?? business.timezone;

    const location = await Location.create(
      {
        businessId,
        name: input.name,
        slug,
        type: input.type,
        description: input.description ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        postalCode: input.postalCode ?? null,
        countryCode: input.countryCode ?? null,
        timezone,
        phone: input.phone ?? null,
        email: input.email ?? null,
        virtualMeetingUrl,
        capacity: input.capacity ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.LOCATION_CREATED,
        entityType: 'location',
        entityId: location.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { slug, name: location.name, type: location.type, timezone },
      },
      { transaction },
    );

    log.info({ businessId, locationId: location.id, slug }, 'location created');
    return location;
  });
}

export async function updateLocation(
  businessId: string,
  locationId: string,
  input: UpdateLocationBody,
  actor: LocationActor,
  metadata: RequestMetadata,
): Promise<Location> {
  if (input.timezone !== undefined) assertTimezone(input.timezone);

  return sequelize.transaction(async (transaction) => {
    const location = await findLocationOrThrow(businessId, locationId, transaction);

    // Checked against the merged state: changing the type alone can invalidate
    // a meeting URL that was legitimate when it was stored.
    const nextType = input.type ?? location.type;
    const nextVirtualUrl =
      input.virtualMeetingUrl !== undefined ? input.virtualMeetingUrl : location.virtualMeetingUrl;
    assertVirtualUrlMatchesType(nextType, nextVirtualUrl);

    const slug =
      input.slug !== undefined
        ? await resolveSlug(businessId, input.slug, input.slug, transaction, location.id)
        : undefined;

    const before = {
      name: location.name,
      slug: location.slug,
      type: location.type,
      timezone: location.timezone,
      isActive: location.isActive,
    };

    await location.update(
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
        ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.virtualMeetingUrl !== undefined
          ? { virtualMeetingUrl: input.virtualMeetingUrl }
          : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
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
        action: AuditActions.LOCATION_UPDATED,
        entityType: 'location',
        entityId: location.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          changed: Object.keys(input),
          before,
          after: {
            name: location.name,
            slug: location.slug,
            type: location.type,
            timezone: location.timezone,
            isActive: location.isActive,
          },
        },
      },
      { transaction },
    );

    return location;
  });
}

export async function deleteLocation(
  businessId: string,
  locationId: string,
  actor: LocationActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const location = await findLocationOrThrow(businessId, locationId, transaction);

    // `endsAt` rather than `startsAt`: an appointment that is running right now
    // still needs the place it was booked into.
    const blocking = await Appointment.count({
      where: {
        businessId,
        locationId: location.id,
        status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
        endsAt: { [Op.gt]: new Date() },
      },
      transaction,
    });

    if (blocking > 0) {
      throw new ConflictError(
        `This location still has ${blocking} upcoming appointment${blocking === 1 ? '' : 's'}. ` +
          'Move or cancel them before deleting it.',
        ErrorCode.CONFLICT,
        { activeAppointments: blocking },
      );
    }

    // Soft delete (the model is paranoid): completed appointments keep
    // resolving the place they happened, and the partial unique index releases
    // the slug for reuse.
    await location.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.LOCATION_DELETED,
        entityType: 'location',
        entityId: location.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { slug: location.slug, name: location.name },
      },
      { transaction },
    );

    log.info({ businessId, locationId: location.id }, 'location deleted');
  });
}
