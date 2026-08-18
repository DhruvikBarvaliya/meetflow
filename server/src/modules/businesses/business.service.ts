/**
 * Workspace (tenant) lifecycle.
 *
 * Creating a business is the one operation that bootstraps a whole tenant:
 * settings, the four built-in roles with their permissions, the creator's
 * owner membership, a staff profile and a sensible default week of opening
 * hours. It all happens in one transaction — a half-created workspace with no
 * owner role would lock its creator out permanently.
 */
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  Business,
  BusinessHours,
  BusinessSettings,
  Membership,
  Permission,
  Role,
  RolePermission,
  StaffProfile,
  User,
} from '../../database/models';
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from '../../utils/errors';
import { slugify, uniqueSlug } from '../../utils/ids';
import { isValidTimezone } from '../../utils/time';
import { AuditActions, recordAudit } from '../audit/audit.service';
import {
  PERMISSION_CATALOGUE,
  SYSTEM_ROLE_TEMPLATES,
  type SystemRoleKey,
} from '../auth/permissions';
import type { RequestMetadata } from '../auth/auth.service';

const log = createLogger('businesses');

/** Mon–Fri, 09:00–17:00 local. A starting point every business will edit. */
const DEFAULT_WEEKDAY_HOURS = { startMinute: 9 * 60, endMinute: 17 * 60 };
const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

/**
 * Upserts the permission catalogue.
 *
 * Called before role creation so a workspace can be created on a database that
 * has been migrated but not seeded — otherwise the owner role would be created
 * with zero permissions and the creator could not administer their own
 * workspace. Idempotent, so the seeder and this path cannot conflict.
 */
export async function ensurePermissionsSeeded(transaction?: Transaction): Promise<Permission[]> {
  const existing = await Permission.findAll({ transaction });
  const known = new Set(existing.map((permission) => permission.key));
  const missing = PERMISSION_CATALOGUE.filter((entry) => !known.has(entry.key));

  if (missing.length > 0) {
    await Permission.bulkCreate(
      missing.map((entry) => ({
        key: entry.key,
        category: entry.category,
        description: entry.description,
      })),
      { transaction, ignoreDuplicates: true },
    );
    log.info({ added: missing.length }, 'permission catalogue synchronised');
    return Permission.findAll({ transaction });
  }
  return existing;
}

/** Clones the built-in role templates into a workspace. */
async function createSystemRoles(
  businessId: string,
  transaction: Transaction,
): Promise<Record<SystemRoleKey, Role>> {
  const permissions = await ensurePermissionsSeeded(transaction);
  const permissionByKey = new Map(permissions.map((permission) => [permission.key, permission.id]));

  const created = {} as Record<SystemRoleKey, Role>;

  for (const template of SYSTEM_ROLE_TEMPLATES) {
    const role = await Role.create(
      {
        businessId,
        key: template.key,
        name: template.name,
        description: template.description,
        isSystem: true,
      },
      { transaction },
    );

    const rows = template.permissions
      .map((key) => permissionByKey.get(key))
      .filter((id): id is string => id !== undefined)
      .map((permissionId) => ({ roleId: role.id, permissionId }));

    if (rows.length !== template.permissions.length) {
      // Would silently hand out a role missing abilities its description
      // promises; fail the whole workspace creation instead.
      throw new Error(
        `Permission catalogue is incomplete: role ${template.key} resolved ` +
          `${rows.length} of ${template.permissions.length} permissions.`,
      );
    }

    await RolePermission.bulkCreate(rows, { transaction });
    created[template.key] = role;
  }

  return created;
}

export interface CreateBusinessInput {
  name: string;
  timezone: string;
  slug?: string;
  description?: string;
  industry?: string;
  currency?: string;
  locale?: string;
  websiteUrl?: string;
  supportEmail?: string;
  supportPhone?: string;
  /** Create a bookable staff profile for the creator. Default true. */
  createStaffProfile?: boolean;
}

export interface CreateBusinessResult {
  business: Business;
  membership: Membership;
  staffProfile: StaffProfile | null;
}

export async function createBusiness(
  userId: string,
  input: CreateBusinessInput,
  metadata: RequestMetadata,
): Promise<CreateBusinessResult> {
  if (!isValidTimezone(input.timezone)) {
    throw new ValidationError('Invalid timezone.', [
      { field: 'timezone', message: 'Must be an IANA timezone identifier such as Asia/Kolkata.' },
    ]);
  }

  const user = await User.findByPk(userId);
  if (!user) throw new NotFoundError('User');

  return sequelize.transaction(async (transaction) => {
    const slug = await uniqueSlug(input.slug ?? input.name, async (candidate) => {
      const clash = await Business.findOne({
        where: { slug: candidate },
        transaction,
        attributes: ['id'],
      });
      return clash !== null;
    });

    const business = await Business.create(
      {
        slug,
        name: input.name.trim(),
        legalName: null,
        description: input.description ?? null,
        industry: input.industry ?? null,
        timezone: input.timezone,
        currency: (input.currency ?? 'USD').toUpperCase(),
        locale: input.locale ?? 'en-US',
        logoUrl: null,
        websiteUrl: input.websiteUrl ?? null,
        supportEmail: input.supportEmail ?? null,
        supportPhone: input.supportPhone ?? null,
        ownerUserId: userId,
      },
      { transaction },
    );

    // Defaults come from the column defaults in the migration, so the policy
    // baseline is defined in exactly one place.
    await BusinessSettings.create({ businessId: business.id }, { transaction });

    const roles = await createSystemRoles(business.id, transaction);

    const membership = await Membership.create(
      {
        userId,
        businessId: business.id,
        roleId: roles.BUSINESS_OWNER.id,
        status: 'ACTIVE',
        invitedByUserId: null,
        invitedAt: null,
        joinedAt: new Date(),
      },
      { transaction },
    );

    let staffProfile: StaffProfile | null = null;
    if (input.createStaffProfile !== false) {
      staffProfile = await StaffProfile.create(
        {
          businessId: business.id,
          userId,
          membershipId: membership.id,
          displayName: `${user.firstName} ${user.lastName}`.trim(),
          title: 'Owner',
          bio: null,
          avatarUrl: null,
          timezone: input.timezone,
          defaultLocationId: null,
          preBufferMinutes: null,
          postBufferMinutes: null,
          minNoticeMinutes: null,
          maxDailyAppointments: null,
          maxWeeklyAppointments: null,
          lastAssignedAt: null,
        },
        { transaction },
      );
    }

    await BusinessHours.bulkCreate(
      DEFAULT_WORKING_DAYS.map((dayOfWeek) => ({
        businessId: business.id,
        locationId: null,
        dayOfWeek,
        startMinute: DEFAULT_WEEKDAY_HOURS.startMinute,
        endMinute: DEFAULT_WEEKDAY_HOURS.endMinute,
      })),
      { transaction },
    );

    await recordAudit(
      {
        businessId: business.id,
        actorType: 'USER',
        actorUserId: userId,
        actorLabel: user.email,
        action: AuditActions.BUSINESS_CREATED,
        entityType: 'business',
        entityId: business.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { slug, timezone: input.timezone, name: business.name },
      },
      { transaction },
    );

    log.info({ businessId: business.id, slug }, 'workspace created');
    return { business, membership, staffProfile };
  });
}

export async function getBusiness(businessId: string): Promise<Business> {
  const business = await Business.findByPk(businessId, {
    include: [{ model: BusinessSettings, as: 'settings' }],
  });
  if (!business) throw new NotFoundError('Workspace');
  return business;
}

export interface UpdateBusinessInput {
  name?: string;
  description?: string | null;
  industry?: string | null;
  timezone?: string;
  currency?: string;
  locale?: string;
  logoUrl?: string | null;
  websiteUrl?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
}

export async function updateBusiness(
  businessId: string,
  input: UpdateBusinessInput,
  actor: { userId: string; email: string },
  metadata: RequestMetadata,
): Promise<Business> {
  if (input.timezone && !isValidTimezone(input.timezone)) {
    throw new ValidationError('Invalid timezone.', [
      { field: 'timezone', message: 'Must be an IANA timezone identifier.' },
    ]);
  }

  const business = await Business.findByPk(businessId);
  if (!business) throw new NotFoundError('Workspace');

  const before = {
    name: business.name,
    timezone: business.timezone,
    currency: business.currency,
  };

  await business.update({
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.industry !== undefined ? { industry: input.industry } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.currency !== undefined ? { currency: input.currency.toUpperCase() } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
    ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}),
    ...(input.supportEmail !== undefined ? { supportEmail: input.supportEmail } : {}),
    ...(input.supportPhone !== undefined ? { supportPhone: input.supportPhone } : {}),
  });

  await recordAudit({
    businessId,
    actorType: 'USER',
    actorUserId: actor.userId,
    actorLabel: actor.email,
    action: AuditActions.BUSINESS_UPDATED,
    entityType: 'business',
    entityId: businessId,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
    metadata: { before, after: { name: business.name, timezone: business.timezone } },
  });

  return business;
}

export interface UpdateSettingsInput {
  slotIntervalMinutes?: number;
  defaultPreBufferMinutes?: number;
  defaultPostBufferMinutes?: number;
  minNoticeMinutes?: number;
  maxHorizonDays?: number;
  cancellationDeadlineMinutes?: number;
  rescheduleDeadlineMinutes?: number;
  allowCustomerCancel?: boolean;
  allowCustomerReschedule?: boolean;
  maxReschedulesPerAppointment?: number;
  requireApproval?: boolean;
  maxBookingsPerCustomerPerDay?: number | null;
  maxBookingsPerStaffPerDay?: number | null;
  noShowGraceMinutes?: number;
  waitlistEnabled?: boolean;
  waitlistHoldMinutes?: number;
  waitlistAutoBook?: boolean;
  reminderOffsetsMinutes?: number[];
  branding?: Record<string, unknown>;
}

export async function getSettings(businessId: string): Promise<BusinessSettings> {
  const [settings] = await BusinessSettings.findOrCreate({
    where: { businessId },
    defaults: { businessId },
  });
  return settings;
}

export async function updateSettings(
  businessId: string,
  input: UpdateSettingsInput,
  actor: { userId: string; email: string },
  metadata: RequestMetadata,
): Promise<BusinessSettings> {
  const settings = await getSettings(businessId);

  if (input.reminderOffsetsMinutes) {
    const offsets = input.reminderOffsetsMinutes;
    if (offsets.some((value) => value <= 0)) {
      throw new ValidationError('Reminder offsets must be positive.', [
        {
          field: 'reminderOffsetsMinutes',
          message: 'Each offset is the number of minutes before the appointment, so must be > 0.',
        },
      ]);
    }
    // Sorted descending: reminders fire furthest-out first, and the order is
    // what the dashboard renders.
    input.reminderOffsetsMinutes = [...new Set(offsets)].sort((a, b) => b - a);
  }

  await settings.update({ ...input });

  await recordAudit({
    businessId,
    actorType: 'USER',
    actorUserId: actor.userId,
    actorLabel: actor.email,
    action: AuditActions.BUSINESS_SETTINGS_UPDATED,
    entityType: 'business_settings',
    entityId: businessId,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
    metadata: { changed: Object.keys(input) },
  });

  return settings;
}

/** Workspace members with their roles, for the people screen. */
export async function listMembers(businessId: string): Promise<Membership[]> {
  return Membership.findAll({
    where: { businessId, status: { [Op.ne]: 'REMOVED' } },
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'firstName', 'lastName', 'avatarUrl', 'status'],
      },
      { model: Role, as: 'role', attributes: ['id', 'key', 'name'] },
      { model: StaffProfile, as: 'staffProfile', attributes: ['id', 'displayName', 'isBookable'] },
    ],
    order: [['createdAt', 'ASC']],
  });
}

export async function listRoles(businessId: string): Promise<Role[]> {
  return Role.findAll({
    where: { businessId },
    include: [{ model: Permission, as: 'permissions', through: { attributes: [] } }],
    order: [['createdAt', 'ASC']],
  });
}

/**
 * Slug availability for the workspace-creation form.
 * Never reveals *which* workspace holds a taken slug.
 */
export async function isSlugAvailable(candidate: string): Promise<boolean> {
  const normalised = slugify(candidate);
  if (!normalised) return false;
  const existing = await Business.findOne({ where: { slug: normalised }, attributes: ['id'] });
  return existing === null;
}

/** Guards against a second workspace with the same name for one owner. */
export async function assertNoDuplicateForOwner(userId: string, name: string): Promise<void> {
  const existing = await Business.findOne({
    where: { ownerUserId: userId, name: name.trim() },
    attributes: ['id'],
  });
  if (existing) {
    throw new ConflictError(
      'You already have a workspace with that name.',
      ErrorCode.ALREADY_EXISTS,
    );
  }
}
