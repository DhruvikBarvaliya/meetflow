/**
 * Resources — the schedulable things that are not people: rooms, chairs,
 * vehicles, machines.
 *
 * Three invariants govern every function here:
 *
 *  1. `businessId` is always the first parameter and always comes from the
 *     caller's proven membership. A row belonging to another workspace must be
 *     indistinguishable from a row that does not exist, so every miss raises
 *     NotFoundError — a 403 would confirm the id is real.
 *  2. `service_resource_requirements` carries no `business_id` of its own. It is
 *     only ever reached through a service already proven to belong to the
 *     tenant, and the resource on the other side is re-checked against the same
 *     businessId before it is linked.
 *  3. A resource is soft-deleted, so the database's `ON DELETE CASCADE` never
 *     fires for it. Anything that would be left dangling by a soft delete is
 *     cleaned up here, in the same transaction.
 */
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  AppointmentResource,
  Location,
  Resource,
  Service,
  ServiceResourceRequirement,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import { ConflictError, ErrorCode, NotFoundError } from '../../utils/errors';
import { slugify, uniqueSlug } from '../../utils/ids';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import type {
  CreateResourceBody,
  ListResourcesQuery,
  ServiceResourceRequirementInput,
  UpdateResourceBody,
} from './resources.validation';

const log = createLogger('resources');

/** Enough to render a chip next to a resource; never the whole location row. */
const LOCATION_SUMMARY_ATTRIBUTES = ['id', 'name', 'slug', 'type', 'timezone', 'isActive'] as const;

const RESOURCE_SUMMARY_ATTRIBUTES = [
  'id',
  'name',
  'slug',
  'type',
  'capacity',
  'color',
  'locationId',
  'isActive',
] as const;

export interface ResourceActor {
  userId: string;
  email: string;
}

export interface Page<T> {
  rows: T[];
  totalItems: number;
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

/**
 * The one place a resource is loaded by id.
 *
 * Scoping on businessId here is what makes every downstream write tenant-safe;
 * the paranoid default also keeps a soft-deleted resource gone as far as the API
 * is concerned.
 */
async function findResourceOrFail(
  businessId: string,
  resourceId: string,
  transaction?: Transaction,
): Promise<Resource> {
  const resource = await Resource.findOne({ where: { id: resourceId, businessId }, transaction });
  if (!resource) throw new NotFoundError('Resource');
  return resource;
}

/** The one place a service is loaded by id from this module. See above. */
async function findServiceOrFail(
  businessId: string,
  serviceId: string,
  transaction?: Transaction,
): Promise<Service> {
  const service = await Service.findOne({ where: { id: serviceId, businessId }, transaction });
  if (!service) throw new NotFoundError('Service');
  return service;
}

/**
 * Resolves a location reference against the tenant.
 *
 * A location id from another workspace answers 404 exactly like an invented one,
 * so this endpoint cannot be used to discover which ids exist elsewhere.
 */
async function resolveLocationId(
  businessId: string,
  locationId: string | null | undefined,
  transaction: Transaction,
): Promise<string | null | undefined> {
  if (locationId === undefined || locationId === null) return locationId;
  const location = await Location.findOne({
    where: { id: locationId, businessId },
    attributes: ['id'],
    transaction,
  });
  if (!location) throw new NotFoundError('Location');
  return location.id;
}

/**
 * Slug collision test, scoped to the workspace.
 *
 * The unique index is partial (`WHERE deleted_at IS NULL`), so the default
 * paranoid scope is deliberate: a retired resource must not hold its slug
 * hostage against the one that replaces it.
 */
function slugTaken(
  businessId: string,
  transaction: Transaction,
  excludeId?: string,
): (candidate: string) => Promise<boolean> {
  return async (candidate: string): Promise<boolean> => {
    const clash = await Resource.findOne({
      where: {
        businessId,
        slug: candidate,
        ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      },
      attributes: ['id'],
      transaction,
    });
    return clash !== null;
  };
}

/**
 * Derives a free slug from `requested` when given, otherwise from the name.
 *
 * A caller-chosen slug that is already taken is a conflict rather than a silent
 * rename: their integrations would otherwise reference a slug they never chose.
 * A slug derived from the name may safely gain a numeric suffix.
 */
async function resolveSlug(
  businessId: string,
  requested: string | undefined,
  fallback: string,
  transaction: Transaction,
  excludeId?: string,
): Promise<string> {
  const slug = await uniqueSlug(
    requested ?? fallback,
    slugTaken(businessId, transaction, excludeId),
  );
  if (requested !== undefined && slug !== slugify(requested)) {
    throw new ConflictError(
      'A resource with that slug already exists in this workspace.',
      ErrorCode.ALREADY_EXISTS,
    );
  }
  return slug;
}

/**
 * Reservations of this resource that have not finished yet.
 *
 * Counted through the appointment so the tenant filter still applies —
 * `appointment_resources` has no `business_id` of its own. `endsAt` rather than
 * `startsAt`: an appointment running right now still needs the room it is in.
 */
async function countHeldReservations(
  businessId: string,
  resourceId: string,
  transaction: Transaction,
): Promise<number> {
  return AppointmentResource.count({
    where: { resourceId, isActive: true, endsAt: { [Op.gt]: new Date() } },
    include: [
      {
        model: Appointment,
        as: 'appointment',
        required: true,
        attributes: [],
        where: { businessId, status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] } },
      },
    ],
    transaction,
  });
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export async function listResources(
  businessId: string,
  query: ListResourcesQuery,
): Promise<Page<Resource>> {
  const { rows, count } = await Resource.findAndCountAll({
    where: {
      businessId,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      // A location from another workspace simply matches nothing: the resources
      // themselves are already fenced by businessId.
      ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
    },
    include: [
      {
        model: Location,
        as: 'location',
        required: false,
        where: { businessId },
        attributes: [...LOCATION_SUMMARY_ATTRIBUTES],
      },
    ],
    order: [
      ['type', 'ASC'],
      ['name', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

export async function getResource(businessId: string, resourceId: string): Promise<Resource> {
  const resource = await Resource.findOne({
    where: { id: resourceId, businessId },
    include: [
      {
        model: Location,
        as: 'location',
        required: false,
        // Defence in depth: the location is already unreachable from another
        // tenant, but a mis-seeded row must not become a cross-tenant disclosure.
        where: { businessId },
        attributes: [...LOCATION_SUMMARY_ATTRIBUTES],
      },
    ],
  });
  if (!resource) throw new NotFoundError('Resource');
  return resource;
}

export async function createResource(
  businessId: string,
  input: CreateResourceBody,
  actor: ResourceActor,
  metadata: RequestMetadata,
): Promise<Resource> {
  // The audit row and the change it describes are committed together, so a
  // catalogue change can never exist without its trail.
  return sequelize.transaction(async (transaction) => {
    const locationId = (await resolveLocationId(businessId, input.locationId, transaction)) ?? null;
    const slug = await resolveSlug(businessId, input.slug, input.name, transaction);

    const resource = await Resource.create(
      {
        businessId,
        locationId,
        name: input.name,
        slug,
        type: input.type,
        description: input.description ?? null,
        capacity: input.capacity,
        color: input.color ?? null,
        isActive: input.isActive,
        deletedAt: null,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.RESOURCE_CREATED,
        entityType: 'resource',
        entityId: resource.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          name: resource.name,
          slug,
          type: resource.type,
          locationId,
          capacity: resource.capacity,
        },
      },
      { transaction },
    );

    log.info({ businessId, resourceId: resource.id, slug }, 'resource created');
    return resource;
  });
}

export async function updateResource(
  businessId: string,
  resourceId: string,
  input: UpdateResourceBody,
  actor: ResourceActor,
  metadata: RequestMetadata,
): Promise<Resource> {
  return sequelize.transaction(async (transaction) => {
    const resource = await findResourceOrFail(businessId, resourceId, transaction);

    const locationId = await resolveLocationId(businessId, input.locationId, transaction);

    const slug =
      input.slug !== undefined && input.slug !== resource.slug
        ? await resolveSlug(businessId, input.slug, input.slug, transaction, resource.id)
        : undefined;

    const before = {
      name: resource.name,
      slug: resource.slug,
      type: resource.type,
      locationId: resource.locationId,
      capacity: resource.capacity,
      isActive: resource.isActive,
    };

    await resource.update(
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(locationId !== undefined ? { locationId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
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
        action: AuditActions.RESOURCE_UPDATED,
        entityType: 'resource',
        entityId: resource.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          changed: Object.keys(input),
          before,
          after: {
            name: resource.name,
            slug: resource.slug,
            type: resource.type,
            locationId: resource.locationId,
            capacity: resource.capacity,
            isActive: resource.isActive,
          },
        },
      },
      { transaction },
    );

    return resource;
  });
}

export async function deleteResource(
  businessId: string,
  resourceId: string,
  actor: ResourceActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const resource = await findResourceOrFail(businessId, resourceId, transaction);

    const blocking = await countHeldReservations(businessId, resource.id, transaction);
    if (blocking > 0) {
      throw new ConflictError(
        `This resource is still held by ${blocking} upcoming appointment${blocking === 1 ? '' : 's'}. ` +
          'Move or cancel them, or deactivate the resource instead.',
        ErrorCode.CONFLICT,
        { activeAppointments: blocking },
      );
    }

    // The FK on service_resource_requirements cascades on a real DELETE, which a
    // soft delete never performs. Left behind, those rows would demand a
    // resource the scheduler can no longer see and quietly make every affected
    // service unbookable, so they are dropped here instead.
    const detached = await ServiceResourceRequirement.destroy({
      where: { resourceId: resource.id },
      transaction,
    });

    // Soft delete (the model is paranoid): past appointments keep resolving the
    // resource they reserved, and the partial unique index releases the slug for
    // reuse.
    await resource.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.RESOURCE_DELETED,
        entityType: 'resource',
        entityId: resource.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          name: resource.name,
          slug: resource.slug,
          type: resource.type,
          requirementsDetached: detached,
        },
      },
      { transaction },
    );

    log.info({ businessId, resourceId: resource.id, detached }, 'resource deleted');
  });
}

// ---------------------------------------------------------------------------
// Service resource requirements
// ---------------------------------------------------------------------------

/** Every named resource must resolve inside this tenant, or the request is a 404. */
async function assertResourcesInBusiness(
  businessId: string,
  resourceIds: readonly string[],
  transaction: Transaction,
): Promise<void> {
  const unique = [...new Set(resourceIds)];
  if (unique.length === 0) return;
  const found = await Resource.count({
    where: { id: { [Op.in]: unique }, businessId },
    transaction,
  });
  if (found !== unique.length) throw new NotFoundError('Resource');
}

/** Requirements of a service that has already been proven to be in the tenant. */
function requirementRowsOf(
  businessId: string,
  serviceId: string,
  transaction?: Transaction,
): Promise<ServiceResourceRequirement[]> {
  return ServiceResourceRequirement.findAll({
    where: { serviceId },
    include: [
      {
        model: Resource,
        as: 'resource',
        // Pooled rows name no resource at all, so the join must stay outer or
        // every "any room" requirement would vanish from the response.
        required: false,
        where: { businessId },
        attributes: [...RESOURCE_SUMMARY_ATTRIBUTES],
      },
    ],
    order: [['createdAt', 'ASC']],
    transaction,
  });
}

/**
 * Not paginated: this is the exact set the PUT counterpart replaces wholesale,
 * and the schema caps it at 50 rows. Handing back a page of it would invite a
 * client to PUT that page and silently drop the rest.
 */
export async function listServiceRequirements(
  businessId: string,
  serviceId: string,
): Promise<ServiceResourceRequirement[]> {
  const service = await findServiceOrFail(businessId, serviceId);
  return requirementRowsOf(businessId, service.id);
}

/**
 * Replaces a service's resource requirements with exactly the set given.
 *
 * Rows are rewritten rather than diffed: a requirement carries no state beyond
 * what the caller just sent, so there is nothing a diff would preserve — and the
 * table has no `deleted_at`, so a dropped row is deleted outright.
 */
export async function replaceServiceRequirements(
  businessId: string,
  serviceId: string,
  requirements: readonly ServiceResourceRequirementInput[],
  actor: ResourceActor,
  metadata: RequestMetadata,
): Promise<ServiceResourceRequirement[]> {
  return sequelize.transaction(async (transaction) => {
    const service = await findServiceOrFail(businessId, serviceId, transaction);

    const namedResourceIds = requirements
      .map((row) => row.resourceId ?? null)
      .filter((id): id is string => id !== null);
    await assertResourcesInBusiness(businessId, namedResourceIds, transaction);

    const removed = await ServiceResourceRequirement.destroy({
      where: { serviceId: service.id },
      transaction,
    });

    if (requirements.length > 0) {
      await ServiceResourceRequirement.bulkCreate(
        requirements.map((row) => ({
          serviceId: service.id,
          resourceId: row.resourceId ?? null,
          resourceType: row.resourceType ?? null,
          quantity: row.quantity,
          isRequired: row.isRequired,
        })),
        { transaction },
      );
    }

    const rows = await requirementRowsOf(businessId, service.id, transaction);

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        // No requirement-specific constant exists; what changed is the service's
        // configuration, which is what the entity ids below identify.
        action: AuditActions.SERVICE_UPDATED,
        entityType: 'service',
        entityId: service.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          change: 'resource_requirements_replaced',
          removed,
          total: rows.length,
          pooled: rows.filter((row) => row.resourceId === null).length,
        },
      },
      { transaction },
    );

    log.info(
      { businessId, serviceId: service.id, removed, total: rows.length },
      'service resource requirements replaced',
    );
    return rows;
  });
}
