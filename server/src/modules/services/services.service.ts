/**
 * The service catalogue — what a workspace sells and the scheduling rules that
 * come with it.
 *
 * Three invariants govern every function here:
 *
 *  1. `businessId` is always the first parameter and always comes from the
 *     caller's proven membership. A row belonging to another workspace must be
 *     indistinguishable from a row that does not exist, so every miss raises
 *     NotFoundError — a 403 would confirm the id is real.
 *  2. `service_staff` and `service_locations` carry no `business_id` of their
 *     own. They are only ever reached through a service already proven to belong
 *     to the tenant, and the staff profile or location on the other side is
 *     re-checked against the same businessId before it is linked.
 *  3. NULL on an override column means "inherit from business settings" and 0
 *     means "explicitly none", so every merge tests for `undefined` rather than
 *     for falsiness — a truthiness check would read a deliberate 0 as an
 *     instruction to inherit.
 */
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  Business,
  Location,
  Service,
  ServiceCategory,
  ServiceLocation,
  ServiceStaff,
  StaffProfile,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from '../../utils/errors';
import { slugify, uniqueSlug } from '../../utils/ids';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import { invalidateBookingPageCache } from '../publicBooking/publicBooking.cache';
import type {
  CreateCategoryBody,
  CreateServiceBody,
  ListCategoriesQuery,
  ListServicesQuery,
  UpdateCategoryBody,
  UpdateServiceBody,
} from './services.validation';

const log = createLogger('services');

/** Enough to render a chip next to a service; never the whole category row. */
const CATEGORY_SUMMARY_ATTRIBUTES = [
  'id',
  'name',
  'slug',
  'color',
  'sortOrder',
  'isActive',
] as const;

const STAFF_SUMMARY_ATTRIBUTES = [
  'id',
  'displayName',
  'title',
  'avatarUrl',
  'color',
  'timezone',
  'isBookable',
  'isActive',
] as const;

const LOCATION_SUMMARY_ATTRIBUTES = ['id', 'name', 'slug', 'type', 'timezone', 'isActive'] as const;

/** The per-pairing overrides a manager edits; the rest of the join row is noise. */
const SERVICE_STAFF_THROUGH_ATTRIBUTES = [
  'durationMinutesOverride',
  'priceAmountOverride',
  'priority',
  'weight',
  'isActive',
] as const;

export interface ServiceActor {
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
 * The one place a category is loaded by id. Scoping on businessId here is what
 * makes every downstream write tenant-safe; the paranoid default also keeps a
 * soft-deleted category gone as far as the API is concerned.
 */
async function findCategoryOrFail(
  businessId: string,
  categoryId: string,
  transaction?: Transaction,
): Promise<ServiceCategory> {
  const category = await ServiceCategory.findOne({
    where: { id: categoryId, businessId },
    transaction,
  });
  if (!category) throw new NotFoundError('Service category');
  return category;
}

/** The one place a service is loaded by id. See findCategoryOrFail. */
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
 * Derives a free slug from `requested` when given, otherwise from the name.
 *
 * A caller-chosen slug that is already taken is a conflict rather than a silent
 * rename: their booking links would otherwise point at a slug they never chose.
 * A slug derived from the name may safely gain a numeric suffix.
 */
async function resolveSlug(
  requested: string | undefined,
  fallback: string,
  taken: (candidate: string) => Promise<boolean>,
  conflictMessage: string,
): Promise<string> {
  const slug = await uniqueSlug(requested ?? fallback, taken);
  if (requested !== undefined && slug !== slugify(requested)) {
    throw new ConflictError(conflictMessage, ErrorCode.ALREADY_EXISTS);
  }
  return slug;
}

/**
 * Slug collision tests, scoped to the workspace.
 *
 * The unique indexes are partial (`WHERE deleted_at IS NULL`), so the default
 * paranoid scope is deliberate: a retired row must not hold its slug hostage
 * against the one that replaces it.
 */
function categorySlugTaken(
  businessId: string,
  transaction: Transaction,
  excludeId?: string,
): (candidate: string) => Promise<boolean> {
  return async (candidate: string): Promise<boolean> => {
    const clash = await ServiceCategory.findOne({
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

function serviceSlugTaken(
  businessId: string,
  transaction: Transaction,
  excludeId?: string,
): (candidate: string) => Promise<boolean> {
  return async (candidate: string): Promise<boolean> => {
    const clash = await Service.findOne({
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
 * Both rules are policy windows measured from "now", so a notice longer than the
 * horizon leaves no bookable instant at all. Only checked when both are set
 * explicitly: a NULL side inherits a business default this module must not
 * second-guess.
 */
function assertNoticeFitsHorizon(
  minNoticeMinutes: number | null,
  maxHorizonDays: number | null,
): void {
  if (minNoticeMinutes === null || maxHorizonDays === null) return;
  if (minNoticeMinutes > maxHorizonDays * 24 * 60) {
    throw new ValidationError('Minimum notice is longer than the booking horizon.', [
      {
        field: 'minNoticeMinutes',
        message: 'No slot can satisfy both rules, so the service would never be bookable.',
      },
    ]);
  }
}

/**
 * Resolves a category reference against the tenant.
 *
 * A category id from another workspace answers 404 exactly like an invented one,
 * so this endpoint cannot be used to discover which ids exist elsewhere.
 */
async function resolveCategoryId(
  businessId: string,
  categoryId: string | null | undefined,
  transaction: Transaction,
): Promise<string | null | undefined> {
  if (categoryId === undefined || categoryId === null) return categoryId;
  const category = await findCategoryOrFail(businessId, categoryId, transaction);
  return category.id;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function listCategories(
  businessId: string,
  query: ListCategoriesQuery,
): Promise<Page<ServiceCategory>> {
  const { rows, count } = await ServiceCategory.findAndCountAll({
    where: {
      businessId,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
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

export async function createCategory(
  businessId: string,
  input: CreateCategoryBody,
  actor: ServiceActor,
  metadata: RequestMetadata,
): Promise<ServiceCategory> {
  // The audit row and the change it describes are committed together, so a
  // catalogue change can never exist without its trail.
  return sequelize.transaction(async (transaction) => {
    const slug = await resolveSlug(
      input.slug,
      input.name,
      categorySlugTaken(businessId, transaction),
      'A service category with that slug already exists in this workspace.',
    );

    const category = await ServiceCategory.create(
      {
        businessId,
        name: input.name,
        slug,
        description: input.description ?? null,
        color: input.color ?? null,
        sortOrder: input.sortOrder,
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
        // No category-specific constant exists; the entity type carries the
        // distinction and the action stays within the catalogue family.
        action: AuditActions.SERVICE_CREATED,
        entityType: 'service_category',
        entityId: category.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { name: category.name, slug: category.slug },
      },
      { transaction },
    );

    log.info({ businessId, categoryId: category.id, slug }, 'service category created');
    return category;
  });
}

export async function updateCategory(
  businessId: string,
  categoryId: string,
  input: UpdateCategoryBody,
  actor: ServiceActor,
  metadata: RequestMetadata,
): Promise<ServiceCategory> {
  return sequelize.transaction(async (transaction) => {
    const category = await findCategoryOrFail(businessId, categoryId, transaction);

    const slug =
      input.slug !== undefined && input.slug !== category.slug
        ? await resolveSlug(
            input.slug,
            input.slug,
            categorySlugTaken(businessId, transaction, category.id),
            'A service category with that slug already exists in this workspace.',
          )
        : undefined;

    const before = {
      name: category.name,
      slug: category.slug,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    };

    await category.update(
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
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
        action: AuditActions.SERVICE_UPDATED,
        entityType: 'service_category',
        entityId: category.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          changed: Object.keys(input),
          before,
          after: {
            name: category.name,
            slug: category.slug,
            sortOrder: category.sortOrder,
            isActive: category.isActive,
          },
        },
      },
      { transaction },
    );

    return category;
  });
}

export async function deleteCategory(
  businessId: string,
  categoryId: string,
  actor: ServiceActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const category = await findCategoryOrFail(businessId, categoryId, transaction);

    // A category is presentational, so removing one must never take bookable
    // services offline: its services are detached instead. The FK's ON DELETE
    // SET NULL cannot do this for us because the row is only soft-deleted.
    const [detached] = await Service.update(
      { categoryId: null },
      { where: { businessId, categoryId: category.id }, transaction },
    );

    await category.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.SERVICE_DELETED,
        entityType: 'service_category',
        entityId: category.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { name: category.name, slug: category.slug, servicesDetached: detached },
      },
      { transaction },
    );

    log.info({ businessId, categoryId: category.id, detached }, 'service category deleted');
  });
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export async function listServices(
  businessId: string,
  query: ListServicesQuery,
): Promise<Page<Service>> {
  const { rows, count } = await Service.findAndCountAll({
    where: {
      businessId,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.isPublic !== undefined ? { isPublic: query.isPublic } : {}),
      // A category from another workspace simply matches nothing: the services
      // themselves are already fenced by businessId.
      ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
    },
    include: [
      {
        model: ServiceCategory,
        as: 'category',
        required: false,
        where: { businessId },
        attributes: [...CATEGORY_SUMMARY_ATTRIBUTES],
      },
    ],
    order: [
      ['sortOrder', 'ASC'],
      ['name', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows, totalItems: count };
}

/**
 * One service with everything the catalogue screen needs.
 *
 * The `where: { businessId }` on each association is defence in depth: the join
 * rows are already unreachable from another tenant, but a mis-seeded row must
 * not become a cross-tenant disclosure.
 */
export async function getService(businessId: string, serviceId: string): Promise<Service> {
  const service = await Service.findOne({
    where: { id: serviceId, businessId },
    include: [
      {
        model: ServiceCategory,
        as: 'category',
        required: false,
        where: { businessId },
        attributes: [...CATEGORY_SUMMARY_ATTRIBUTES],
      },
      {
        model: StaffProfile,
        as: 'staff',
        required: false,
        where: { businessId },
        attributes: [...STAFF_SUMMARY_ATTRIBUTES],
        through: { attributes: [...SERVICE_STAFF_THROUGH_ATTRIBUTES] },
      },
      {
        model: Location,
        as: 'locations',
        required: false,
        where: { businessId },
        attributes: [...LOCATION_SUMMARY_ATTRIBUTES],
        through: { attributes: [] },
      },
    ],
    order: [
      [{ model: StaffProfile, as: 'staff' }, 'displayName', 'ASC'],
      [{ model: Location, as: 'locations' }, 'name', 'ASC'],
    ],
  });

  if (!service) throw new NotFoundError('Service');
  return service;
}

export async function createService(
  businessId: string,
  input: CreateServiceBody,
  actor: ServiceActor,
  metadata: RequestMetadata,
): Promise<Service> {
  const minNoticeMinutes = input.minNoticeMinutes ?? null;
  const maxHorizonDays = input.maxHorizonDays ?? null;
  assertNoticeFitsHorizon(minNoticeMinutes, maxHorizonDays);

  return sequelize.transaction(async (transaction) => {
    // Prices are stored in the smallest unit of *some* currency. Falling through
    // to the column default would stamp USD on an INR catalogue and only show up
    // once a customer is looking at a checkout page.
    const business = await Business.findByPk(businessId, {
      attributes: ['id', 'currency'],
      transaction,
    });
    if (!business) throw new NotFoundError('Workspace');

    const categoryId = (await resolveCategoryId(businessId, input.categoryId, transaction)) ?? null;

    const slug = await resolveSlug(
      input.slug,
      input.name,
      serviceSlugTaken(businessId, transaction),
      'A service with that slug already exists in this workspace.',
    );

    const service = await Service.create(
      {
        businessId,
        categoryId,
        name: input.name,
        slug,
        description: input.description ?? null,
        durationMinutes: input.durationMinutes,
        preBufferMinutes: input.preBufferMinutes ?? null,
        postBufferMinutes: input.postBufferMinutes ?? null,
        priceAmount: input.priceAmount,
        currency: business.currency,
        capacity: input.capacity,
        minNoticeMinutes,
        maxHorizonDays,
        slotIntervalMinutes: input.slotIntervalMinutes ?? null,
        maxPerCustomerPerDay: input.maxPerCustomerPerDay ?? null,
        requiresApproval: input.requiresApproval,
        assignmentStrategy: input.assignmentStrategy,
        color: input.color ?? null,
        isPublic: input.isPublic,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
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
        action: AuditActions.SERVICE_CREATED,
        entityType: 'service',
        entityId: service.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          name: service.name,
          slug: service.slug,
          categoryId,
          durationMinutes: service.durationMinutes,
          priceAmount: service.priceAmount,
          currency: service.currency,
          capacity: service.capacity,
        },
      },
      { transaction },
    );

    // A new service can appear on a booking page the moment it exists — a
    // CATALOG link offers what the workspace sells — so the pages that were
    // assembled without it are no longer what the operator publishes.
    await invalidateBookingPageCache(businessId, transaction);

    log.info({ businessId, serviceId: service.id, slug }, 'service created');
    return service;
  });
}

export async function updateService(
  businessId: string,
  serviceId: string,
  input: UpdateServiceBody,
  actor: ServiceActor,
  metadata: RequestMetadata,
): Promise<Service> {
  return sequelize.transaction(async (transaction) => {
    const service = await findServiceOrFail(businessId, serviceId, transaction);

    // Checked against the merged state: relaxing one of the two windows in the
    // same patch that tightens the other is legitimate.
    assertNoticeFitsHorizon(
      input.minNoticeMinutes !== undefined ? input.minNoticeMinutes : service.minNoticeMinutes,
      input.maxHorizonDays !== undefined ? input.maxHorizonDays : service.maxHorizonDays,
    );

    const categoryId = await resolveCategoryId(businessId, input.categoryId, transaction);

    const slug =
      input.slug !== undefined && input.slug !== service.slug
        ? await resolveSlug(
            input.slug,
            input.slug,
            serviceSlugTaken(businessId, transaction, service.id),
            'A service with that slug already exists in this workspace.',
          )
        : undefined;

    const before = {
      name: service.name,
      slug: service.slug,
      categoryId: service.categoryId,
      durationMinutes: service.durationMinutes,
      priceAmount: service.priceAmount,
      capacity: service.capacity,
      isActive: service.isActive,
      isPublic: service.isPublic,
    };

    await service.update(
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.preBufferMinutes !== undefined
          ? { preBufferMinutes: input.preBufferMinutes }
          : {}),
        ...(input.postBufferMinutes !== undefined
          ? { postBufferMinutes: input.postBufferMinutes }
          : {}),
        ...(input.priceAmount !== undefined ? { priceAmount: input.priceAmount } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.minNoticeMinutes !== undefined
          ? { minNoticeMinutes: input.minNoticeMinutes }
          : {}),
        ...(input.maxHorizonDays !== undefined ? { maxHorizonDays: input.maxHorizonDays } : {}),
        ...(input.slotIntervalMinutes !== undefined
          ? { slotIntervalMinutes: input.slotIntervalMinutes }
          : {}),
        ...(input.maxPerCustomerPerDay !== undefined
          ? { maxPerCustomerPerDay: input.maxPerCustomerPerDay }
          : {}),
        ...(input.requiresApproval !== undefined
          ? { requiresApproval: input.requiresApproval }
          : {}),
        ...(input.assignmentStrategy !== undefined
          ? { assignmentStrategy: input.assignmentStrategy }
          : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.SERVICE_UPDATED,
        entityType: 'service',
        entityId: service.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          changed: Object.keys(input),
          before,
          after: {
            name: service.name,
            slug: service.slug,
            categoryId: service.categoryId,
            durationMinutes: service.durationMinutes,
            priceAmount: service.priceAmount,
            capacity: service.capacity,
            isActive: service.isActive,
            isPublic: service.isPublic,
          },
        },
      },
      { transaction },
    );

    // The public page quotes this row's name, price, duration and capacity, so
    // an edit that is not followed by an invalidation is an edit the customer
    // does not see until the cache TTL runs out.
    await invalidateBookingPageCache(businessId, transaction);

    return service;
  });
}

export async function deleteService(
  businessId: string,
  serviceId: string,
  actor: ServiceActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const service = await findServiceOrFail(businessId, serviceId, transaction);

    // `endsAt` rather than `startsAt`: an appointment running right now still
    // needs the service it was booked against.
    const blocking = await Appointment.count({
      where: {
        businessId,
        serviceId: service.id,
        status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
        endsAt: { [Op.gt]: new Date() },
      },
      transaction,
    });

    if (blocking > 0) {
      throw new ConflictError(
        `This service still has ${blocking} upcoming appointment${blocking === 1 ? '' : 's'}. ` +
          'Move or cancel them, or deactivate the service instead.',
        ErrorCode.CONFLICT,
        { activeAppointments: blocking },
      );
    }

    // Soft delete (the model is paranoid): past appointments keep resolving the
    // service they were booked against, and the partial unique index releases
    // the slug for reuse. Staff and location assignments are left in place —
    // they are only reachable through the service, which is now invisible.
    await service.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.SERVICE_DELETED,
        entityType: 'service',
        entityId: service.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { name: service.name, slug: service.slug },
      },
      { transaction },
    );

    // A retired service that a cached page still offers is worse than a stale
    // price: a customer picks it, and the booking is refused by a catalogue
    // that no longer has it.
    await invalidateBookingPageCache(businessId, transaction);

    log.info({ businessId, serviceId: service.id }, 'service deleted');
  });
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/**
 * Splits a wanted set against the rows that already exist.
 *
 * Computed in memory rather than with `Op.notIn`, which degenerates to
 * `NOT IN (NULL)` on an empty array and would silently delete nothing when the
 * caller asked for the set to be emptied.
 */
function diffAssignments(
  wanted: readonly string[],
  current: readonly string[],
): { added: string[]; removed: string[] } {
  const keep = new Set(wanted);
  const present = new Set(current);
  return {
    added: wanted.filter((id) => !present.has(id)),
    removed: current.filter((id) => !keep.has(id)),
  };
}

/** Every id must resolve inside this tenant, or the whole request is a 404. */
async function assertStaffInBusiness(
  businessId: string,
  staffProfileIds: readonly string[],
  transaction: Transaction,
): Promise<void> {
  if (staffProfileIds.length === 0) return;
  const found = await StaffProfile.count({
    where: { id: { [Op.in]: [...staffProfileIds] }, businessId },
    transaction,
  });
  if (found !== staffProfileIds.length) throw new NotFoundError('Staff profile');
}

async function assertLocationsInBusiness(
  businessId: string,
  locationIds: readonly string[],
  transaction: Transaction,
): Promise<void> {
  if (locationIds.length === 0) return;
  const found = await Location.count({
    where: { id: { [Op.in]: [...locationIds] }, businessId },
    transaction,
  });
  if (found !== locationIds.length) throw new NotFoundError('Location');
}

/**
 * Replaces the set of staff who may deliver a service.
 *
 * Pairings that survive the replacement keep their row, and therefore their
 * duration and price overrides: re-sending an unchanged colleague in the list
 * must not silently reset what a manager configured for them.
 */
export async function replaceServiceStaff(
  businessId: string,
  serviceId: string,
  staffProfileIds: readonly string[],
  actor: ServiceActor,
  metadata: RequestMetadata,
): Promise<ServiceStaff[]> {
  return sequelize.transaction(async (transaction) => {
    const service = await findServiceOrFail(businessId, serviceId, transaction);
    await assertStaffInBusiness(businessId, staffProfileIds, transaction);

    const existing = await ServiceStaff.findAll({
      where: { serviceId: service.id },
      attributes: ['id', 'staffProfileId'],
      transaction,
    });

    const { added, removed } = diffAssignments(
      staffProfileIds,
      existing.map((row) => row.staffProfileId),
    );

    if (removed.length > 0) {
      // Hard delete: service_staff has no deleted_at, and the unique index on
      // (service_id, staff_profile_id) needs the row gone before the pairing can
      // be created again.
      await ServiceStaff.destroy({
        where: { serviceId: service.id, staffProfileId: { [Op.in]: removed } },
        transaction,
      });
    }

    if (added.length > 0) {
      await ServiceStaff.bulkCreate(
        added.map((staffProfileId) => ({ serviceId: service.id, staffProfileId })),
        { transaction },
      );
    }

    const rows = await ServiceStaff.findAll({
      where: { serviceId: service.id },
      include: [
        {
          model: StaffProfile,
          as: 'staffProfile',
          required: true,
          where: { businessId },
          attributes: [...STAFF_SUMMARY_ATTRIBUTES],
        },
      ],
      order: [
        ['priority', 'ASC'],
        ['createdAt', 'ASC'],
      ],
      transaction,
    });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.SERVICE_UPDATED,
        entityType: 'service',
        entityId: service.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { change: 'staff_replaced', added, removed, total: rows.length },
      },
      { transaction },
    );

    // `service_staff` is what a page's provider list is derived from, so a
    // provider added to or taken off this service changes who the public page
    // offers to book with.
    await invalidateBookingPageCache(businessId, transaction);

    log.info(
      { businessId, serviceId: service.id, added: added.length, removed: removed.length },
      'service staff replaced',
    );
    return rows;
  });
}

/**
 * Replaces the set of locations where a service is offered.
 *
 * An empty set is not "nowhere": a service with no rows in service_locations is
 * offered at every active location, which is exactly how a single-site workspace
 * behaves without ever touching this endpoint.
 */
export async function replaceServiceLocations(
  businessId: string,
  serviceId: string,
  locationIds: readonly string[],
  actor: ServiceActor,
  metadata: RequestMetadata,
): Promise<ServiceLocation[]> {
  return sequelize.transaction(async (transaction) => {
    const service = await findServiceOrFail(businessId, serviceId, transaction);
    await assertLocationsInBusiness(businessId, locationIds, transaction);

    const existing = await ServiceLocation.findAll({
      where: { serviceId: service.id },
      attributes: ['id', 'locationId'],
      transaction,
    });

    const { added, removed } = diffAssignments(
      locationIds,
      existing.map((row) => row.locationId),
    );

    if (removed.length > 0) {
      await ServiceLocation.destroy({
        where: { serviceId: service.id, locationId: { [Op.in]: removed } },
        transaction,
      });
    }

    if (added.length > 0) {
      await ServiceLocation.bulkCreate(
        added.map((locationId) => ({ serviceId: service.id, locationId })),
        { transaction },
      );
    }

    const rows = await ServiceLocation.findAll({
      where: { serviceId: service.id },
      include: [
        {
          model: Location,
          as: 'location',
          required: true,
          where: { businessId },
          attributes: [...LOCATION_SUMMARY_ATTRIBUTES],
        },
      ],
      order: [['createdAt', 'ASC']],
      transaction,
    });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.SERVICE_UPDATED,
        entityType: 'service',
        entityId: service.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { change: 'locations_replaced', added, removed, total: rows.length },
      },
      { transaction },
    );

    // Same reason as the staff pairings: `service_locations` decides which
    // sites a page offers, including the "no rows means everywhere" case where
    // adding the first row *narrows* the list a customer sees.
    await invalidateBookingPageCache(businessId, transaction);

    log.info(
      { businessId, serviceId: service.id, added: added.length, removed: removed.length },
      'service locations replaced',
    );
    return rows;
  });
}
