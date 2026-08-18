/**
 * Public booking links — the page a customer actually lands on.
 *
 * Four invariants govern every function here:
 *
 *  1. `businessId` is always the first parameter and always comes from the
 *     caller's proven membership. A row belonging to another workspace must be
 *     indistinguishable from a row that does not exist, so every miss raises
 *     NotFoundError — a 403 would confirm the id is real.
 *  2. The slug is the entire public URL path, so it is unique across the
 *     *platform* rather than per tenant. Its collision probe is the one query
 *     here that is deliberately not tenant-scoped: it reads nothing but whether
 *     a row exists, and a clash is reported without naming the holder.
 *  3. `booking_link_services` carries no `business_id` of its own. It is only
 *     ever reached through a link already proven to belong to the tenant, and
 *     every service on the other side is re-checked against the same
 *     businessId.
 *  4. `type` and the populated target id must agree, exactly as
 *     `booking_links_target_check` demands. The rule is enforced against the
 *     *merged* state so a PATCH cannot leave the row in a shape the database
 *     would reject — or in one it tolerates but the public page cannot render.
 */
import { Op, type InferAttributes, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  BookingLink,
  BookingLinkService,
  Location,
  Service,
  StaffProfile,
  Team,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import type { BookingLinkType } from '../../database/models/BookingLink';
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from '../../utils/errors';
import { slugify, uniqueSlug } from '../../utils/ids';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import type {
  CreateBookingLinkBody,
  CustomQuestion,
  ListBookingLinksQuery,
  UpdateBookingLinkBody,
} from './bookingLinks.validation';

const log = createLogger('booking-links');

/** Enough to render the offered-services list; never the whole service row. */
const SERVICE_SUMMARY_ATTRIBUTES = [
  'id',
  'name',
  'slug',
  'durationMinutes',
  'priceAmount',
  'currency',
  'capacity',
  'isPublic',
  'isActive',
] as const;

export interface BookingLinkActor {
  userId: string;
  email: string;
}

type BookingLinkAttributes = InferAttributes<BookingLink>;

export type BookingLinkView = BookingLinkAttributes & {
  /** Where the customer actually goes: PUBLIC_APP_URL joined with the slug. */
  publicUrl: string;
  /** Active, inside its window and under its cap — the one flag the UI needs. */
  isBookable: boolean;
};

export type BookingLinkDetail = BookingLinkView & {
  services: BookingLinkService[];
};

export interface BookingLinkPage {
  rows: BookingLinkView[];
  totalItems: number;
}

interface TargetIds {
  serviceId: string | null;
  teamId: string | null;
  staffProfileId: string | null;
}

/** Mirrors `booking_links_target_check`. CATALOG names no single target. */
const TARGET_FIELD_BY_TYPE: Record<BookingLinkType, keyof TargetIds | null> = {
  SINGLE_SERVICE: 'serviceId',
  TEAM: 'teamId',
  STAFF: 'staffProfileId',
  CATALOG: null,
};

const TARGET_LABEL: Record<keyof TargetIds, string> = {
  serviceId: 'service',
  teamId: 'team',
  staffProfileId: 'staff member',
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * `%` and `_` are wildcards to LIKE, so an unescaped search term of "%" would
 * match every link instead of the one the user is looking for.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The public address of a link.
 *
 * The `/b/` prefix is not decoration — it is the path the client router serves
 * the booking page from. Omitting it produces a URL that looks right in the
 * dashboard, gets copied into a customer email, and 404s for every recipient.
 *
 * PUBLIC_APP_URL may or may not end in a slash.
 */
function publicUrlFor(slug: string): string {
  return `${env.PUBLIC_APP_URL.replace(/\/+$/, '')}/b/${slug}`;
}

function toView(link: BookingLink): BookingLinkView {
  return {
    ...link.toJSON<BookingLinkAttributes>(),
    publicUrl: publicUrlFor(link.slug),
    isBookable: link.isBookable,
  };
}

/** JSONB columns are plain object bags once they reach the row. */
function toStoredQuestions(questions: readonly CustomQuestion[]): Record<string, unknown>[] {
  return questions.map((question) => ({ ...question }));
}

/**
 * The one place a link is loaded by id. Scoping on businessId here is what
 * makes every downstream write tenant-safe; the paranoid default also keeps a
 * soft-deleted link gone as far as the API is concerned.
 */
async function findBookingLinkOrFail(
  businessId: string,
  bookingLinkId: string,
  transaction?: Transaction,
): Promise<BookingLink> {
  const link = await BookingLink.findOne({
    where: { id: bookingLinkId, businessId },
    transaction,
  });
  if (!link) throw new NotFoundError('Booking link');
  return link;
}

/**
 * The offered services of a link.
 *
 * The join on Service is a second tenant check: the join table has no
 * business_id, so a row pointing at another workspace's service could never
 * surface through this query.
 */
async function loadServices(
  businessId: string,
  bookingLinkId: string,
  transaction?: Transaction,
): Promise<BookingLinkService[]> {
  return BookingLinkService.findAll({
    where: { bookingLinkId },
    include: [
      {
        model: Service,
        as: 'service',
        required: true,
        where: { businessId },
        attributes: [...SERVICE_SUMMARY_ATTRIBUTES],
      },
    ],
    order: [
      ['sortOrder', 'ASC'],
      ['createdAt', 'ASC'],
    ],
    transaction,
  });
}

async function toDetail(
  businessId: string,
  link: BookingLink,
  transaction?: Transaction,
): Promise<BookingLinkDetail> {
  return { ...toView(link), services: await loadServices(businessId, link.id, transaction) };
}

/**
 * Enforces the type/target pairing on the state that is about to be written.
 *
 * Stricter than the database, which only demands the type's own target: a
 * CATALOG link carrying a serviceId would store an intention the public page
 * never acts on, and would come back to life the moment the type flipped.
 */
function assertTargetMatchesType(type: BookingLinkType, targets: TargetIds): void {
  const expected = TARGET_FIELD_BY_TYPE[type];

  for (const field of ['serviceId', 'teamId', 'staffProfileId'] as const) {
    const value = targets[field];

    if (field === expected) {
      if (value === null) {
        throw new ValidationError(`A ${type} booking link is incomplete.`, [
          { field, message: `A ${type} link must name the ${TARGET_LABEL[field]} it books.` },
        ]);
      }
      continue;
    }

    if (value !== null) {
      throw new ValidationError(`A ${type} booking link cannot carry that target.`, [
        { field, message: `A ${type} link cannot also name a ${TARGET_LABEL[field]}.` },
      ]);
    }
  }
}

/**
 * Every referenced row must live in this tenant.
 *
 * A target from another workspace answers 404 exactly like one that was never
 * created, so a booking link cannot be used to probe another tenant's
 * catalogue, teams or roster.
 */
async function assertTargetsInBusiness(
  businessId: string,
  targets: TargetIds & { locationId: string | null },
  transaction: Transaction,
): Promise<void> {
  if (targets.serviceId !== null) {
    const service = await Service.findOne({
      where: { id: targets.serviceId, businessId },
      attributes: ['id'],
      transaction,
    });
    if (!service) throw new NotFoundError('Service');
  }

  if (targets.teamId !== null) {
    const team = await Team.findOne({
      where: { id: targets.teamId, businessId },
      attributes: ['id'],
      transaction,
    });
    if (!team) throw new NotFoundError('Team');
  }

  if (targets.staffProfileId !== null) {
    const staffProfile = await StaffProfile.findOne({
      where: { id: targets.staffProfileId, businessId },
      attributes: ['id'],
      transaction,
    });
    if (!staffProfile) throw new NotFoundError('Staff profile');
  }

  if (targets.locationId !== null) {
    const location = await Location.findOne({
      where: { id: targets.locationId, businessId },
      attributes: ['id'],
      transaction,
    });
    if (!location) throw new NotFoundError('Location');
  }
}

/** Every offered service must resolve inside this tenant, or it is a 404. */
async function assertServicesInBusiness(
  businessId: string,
  serviceIds: readonly string[],
  transaction: Transaction,
): Promise<void> {
  if (serviceIds.length === 0) return;
  const found = await Service.count({
    where: { id: { [Op.in]: [...serviceIds] }, businessId },
    transaction,
  });
  if (found !== serviceIds.length) throw new NotFoundError('Service');
}

/**
 * A free slug, checked against every booking link on the platform.
 *
 * Deliberately not tenant-scoped: the slug is the whole public path, so one
 * workspace taking it takes it from all of them. The probe reads only `id`, and
 * a caller-chosen clash is answered without saying who holds the name — which
 * workspace owns a public address is not this caller's business.
 */
async function resolveSlug(
  requested: string | undefined,
  fallback: string,
  transaction: Transaction,
  excludeId?: string,
): Promise<string> {
  const slug = await uniqueSlug(requested ?? fallback, async (candidate) => {
    // Paranoid default matches the partial unique index (deleted_at IS NULL):
    // a retired link releases its address for reuse.
    const clash = await BookingLink.findOne({
      where: {
        slug: candidate,
        ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      },
      attributes: ['id'],
      transaction,
    });
    return clash !== null;
  });

  // A slug derived from the name may gain a numeric suffix, but one the caller
  // chose must not be quietly rewritten: they would print the address they
  // asked for and it would lead somewhere else.
  if (requested !== undefined && slug !== slugify(requested)) {
    throw new ConflictError(
      'That booking link address is already taken. Choose another.',
      ErrorCode.ALREADY_EXISTS,
    );
  }
  return slug;
}

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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listBookingLinks(
  businessId: string,
  query: ListBookingLinksQuery,
): Promise<BookingLinkPage> {
  const term = query.search ? `%${escapeLike(query.search)}%` : null;

  const { rows, count } = await BookingLink.findAndCountAll({
    where: {
      businessId,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(term
        ? { [Op.or]: [{ name: { [Op.iLike]: term } }, { slug: { [Op.iLike]: term } }] }
        : {}),
    },
    order: [['createdAt', 'DESC']],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { rows: rows.map(toView), totalItems: count };
}

export async function getBookingLink(
  businessId: string,
  bookingLinkId: string,
): Promise<BookingLinkDetail> {
  const link = await findBookingLinkOrFail(businessId, bookingLinkId);
  return toDetail(businessId, link);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createBookingLink(
  businessId: string,
  input: CreateBookingLinkBody,
  actor: BookingLinkActor,
  metadata: RequestMetadata,
): Promise<BookingLinkDetail> {
  const targets: TargetIds = {
    serviceId: input.serviceId ?? null,
    teamId: input.teamId ?? null,
    staffProfileId: input.staffProfileId ?? null,
  };
  assertTargetMatchesType(input.type, targets);

  const serviceIds = input.serviceIds ?? [];
  const locationId = input.locationId ?? null;

  if (serviceIds.length > 0 && input.type !== 'CATALOG') {
    throw new ValidationError('Only a CATALOG link offers a list of services.', [
      {
        field: 'serviceIds',
        message: `A ${input.type} link books the single target named on the link itself.`,
      },
    ]);
  }

  // The link and its offered services are one publishable unit — a link that
  // committed without its catalogue would be a live page offering nothing.
  return sequelize.transaction(async (transaction) => {
    await assertTargetsInBusiness(businessId, { ...targets, locationId }, transaction);
    await assertServicesInBusiness(businessId, serviceIds, transaction);

    const slug = await resolveSlug(input.slug, input.name, transaction);

    const link = await BookingLink.create(
      {
        businessId,
        slug,
        name: input.name,
        description: input.description ?? null,
        type: input.type,
        ...targets,
        locationId,
        allowStaffSelection: input.allowStaffSelection,
        requiresApproval: input.requiresApproval,
        customQuestions: toStoredQuestions(input.customQuestions),
        branding: input.branding,
        maxBookingsTotal: input.maxBookingsTotal ?? null,
        expiresAt: input.expiresAt ?? null,
        isActive: input.isActive,
        deletedAt: null,
      },
      { transaction },
    );

    if (serviceIds.length > 0) {
      // Array position is the display order the caller chose.
      await BookingLinkService.bulkCreate(
        serviceIds.map((serviceId, index) => ({
          bookingLinkId: link.id,
          serviceId,
          sortOrder: index,
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
        action: AuditActions.BOOKING_LINK_CREATED,
        entityType: 'booking_link',
        entityId: link.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          slug,
          name: link.name,
          type: link.type,
          ...targets,
          locationId,
          serviceCount: serviceIds.length,
          isActive: link.isActive,
        },
      },
      { transaction },
    );

    log.info({ businessId, bookingLinkId: link.id, slug }, 'booking link created');
    return toDetail(businessId, link, transaction);
  });
}

export async function updateBookingLink(
  businessId: string,
  bookingLinkId: string,
  input: UpdateBookingLinkBody,
  actor: BookingLinkActor,
  metadata: RequestMetadata,
): Promise<BookingLinkDetail> {
  return sequelize.transaction(async (transaction) => {
    const link = await findBookingLinkOrFail(businessId, bookingLinkId, transaction);

    const nextType = input.type ?? link.type;
    const typeChanged = nextType !== link.type;

    // A type change strands the previous target: a link switched to STAFF must
    // not keep pointing at the service its old type named, so an unmentioned
    // target is cleared rather than inherited.
    const inherited = (
      supplied: string | null | undefined,
      current: string | null,
    ): string | null => (supplied !== undefined ? supplied : typeChanged ? null : current);

    const targets: TargetIds = {
      serviceId: inherited(input.serviceId, link.serviceId),
      teamId: inherited(input.teamId, link.teamId),
      staffProfileId: inherited(input.staffProfileId, link.staffProfileId),
    };
    const locationId = input.locationId !== undefined ? input.locationId : link.locationId;

    assertTargetMatchesType(nextType, targets);
    await assertTargetsInBusiness(businessId, { ...targets, locationId }, transaction);

    const slug =
      input.slug !== undefined && input.slug !== link.slug
        ? await resolveSlug(input.slug, input.slug, transaction, link.id)
        : undefined;

    const before = {
      slug: link.slug,
      name: link.name,
      type: link.type,
      serviceId: link.serviceId,
      teamId: link.teamId,
      staffProfileId: link.staffProfileId,
      locationId: link.locationId,
      isActive: link.isActive,
    };

    await link.update(
      {
        ...(slug !== undefined ? { slug } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        type: nextType,
        ...targets,
        locationId,
        ...(input.allowStaffSelection !== undefined
          ? { allowStaffSelection: input.allowStaffSelection }
          : {}),
        ...(input.requiresApproval !== undefined
          ? { requiresApproval: input.requiresApproval }
          : {}),
        ...(input.customQuestions !== undefined
          ? { customQuestions: toStoredQuestions(input.customQuestions) }
          : {}),
        ...(input.branding !== undefined ? { branding: input.branding } : {}),
        ...(input.maxBookingsTotal !== undefined
          ? { maxBookingsTotal: input.maxBookingsTotal }
          : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      { transaction },
    );

    // Only a CATALOG link renders the offered-services list. Leaving the rows
    // behind would keep stale offerings that reappear the moment the type is
    // switched back, long after the operator stopped seeing them.
    if (typeChanged && nextType !== 'CATALOG') {
      await BookingLinkService.destroy({ where: { bookingLinkId: link.id }, transaction });
    }

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.BOOKING_LINK_UPDATED,
        entityType: 'booking_link',
        entityId: link.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          changed: Object.keys(input),
          before,
          after: {
            slug: link.slug,
            name: link.name,
            type: link.type,
            serviceId: link.serviceId,
            teamId: link.teamId,
            staffProfileId: link.staffProfileId,
            locationId: link.locationId,
            isActive: link.isActive,
          },
        },
      },
      { transaction },
    );

    return toDetail(businessId, link, transaction);
  });
}

export async function deleteBookingLink(
  businessId: string,
  bookingLinkId: string,
  actor: BookingLinkActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const link = await findBookingLinkOrFail(businessId, bookingLinkId, transaction);

    // `endsAt` rather than `startsAt`: an appointment running right now was
    // still booked through this link and its confirmation page still resolves
    // against it.
    const blocking = await Appointment.count({
      where: {
        businessId,
        bookingLinkId: link.id,
        status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
        endsAt: { [Op.gt]: new Date() },
      },
      transaction,
    });

    if (blocking > 0) {
      throw new ConflictError(
        `This link still has ${blocking} upcoming appointment${blocking === 1 ? '' : 's'}. ` +
          'Deactivate it with isActive to stop new bookings, or clear those first.',
        ErrorCode.CONFLICT,
        { activeAppointments: blocking },
      );
    }

    // Soft delete (the model is paranoid): past appointments keep resolving the
    // link they came through, while the partial unique index releases the
    // public address. The join rows stay with the hidden link, so a restore
    // brings back the page the operator retired.
    await link.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        // No BOOKING_LINK_DELETED constant exists; BOOKING_LINK_UPDATED keeps
        // the entity type honest and the metadata says what actually happened.
        action: AuditActions.BOOKING_LINK_UPDATED,
        entityType: 'booking_link',
        entityId: link.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { change: 'deleted', slug: link.slug, name: link.name, type: link.type },
      },
      { transaction },
    );

    log.info({ businessId, bookingLinkId: link.id }, 'booking link deleted');
  });
}

/**
 * Replaces the set of services a CATALOG link offers.
 *
 * Pairings that survive keep their row; only their position moves. The array
 * order is the order the public page lists them in, so a reorder is expressed
 * by re-sending the same ids in a different sequence.
 */
export async function replaceBookingLinkServices(
  businessId: string,
  bookingLinkId: string,
  serviceIds: readonly string[],
  actor: BookingLinkActor,
  metadata: RequestMetadata,
): Promise<BookingLinkDetail> {
  return sequelize.transaction(async (transaction) => {
    const link = await findBookingLinkOrFail(businessId, bookingLinkId, transaction);

    if (link.type !== 'CATALOG') {
      throw new ConflictError(
        `A ${link.type} link books the single target named on the link itself, so it has no ` +
          'list of offered services. Change its type to CATALOG first.',
        ErrorCode.CONFLICT,
        { type: link.type },
      );
    }

    await assertServicesInBusiness(businessId, serviceIds, transaction);

    const existing = await BookingLinkService.findAll({
      where: { bookingLinkId: link.id },
      transaction,
    });

    const { added, removed } = diffAssignments(
      serviceIds,
      existing.map((row) => row.serviceId),
    );

    if (removed.length > 0) {
      // Hard delete: booking_link_services has no deleted_at, and the unique
      // index on (booking_link_id, service_id) needs the row gone before the
      // pairing can be created again.
      await BookingLinkService.destroy({
        where: { bookingLinkId: link.id, serviceId: { [Op.in]: removed } },
        transaction,
      });
    }

    const byService = new Map(existing.map((row) => [row.serviceId, row]));
    for (const [index, serviceId] of serviceIds.entries()) {
      const row = byService.get(serviceId);
      if (!row) {
        await BookingLinkService.create(
          { bookingLinkId: link.id, serviceId, sortOrder: index },
          { transaction },
        );
      } else if (row.sortOrder !== index) {
        await row.update({ sortOrder: index }, { transaction });
      }
    }

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.BOOKING_LINK_UPDATED,
        entityType: 'booking_link',
        entityId: link.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          change: 'services_replaced',
          added,
          removed,
          total: serviceIds.length,
        },
      },
      { transaction },
    );

    log.info(
      { businessId, bookingLinkId: link.id, added: added.length, removed: removed.length },
      'booking link services replaced',
    );
    return toDetail(businessId, link, transaction);
  });
}
