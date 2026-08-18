/**
 * Teams — groups of staff that can be booked as one unit.
 *
 * Two invariants govern every function here:
 *
 *  1. `businessId` is always the first parameter and always comes from the
 *     caller's membership. A row belonging to another workspace must be
 *     indistinguishable from a row that does not exist, so every miss raises
 *     NotFoundError — never a 403, which would confirm the id is real.
 *  2. `team_members` carries no `business_id` of its own. It is therefore only
 *     ever reached through a team that has already been proven to belong to the
 *     tenant, and the staff profile on each side is re-checked against the same
 *     businessId. There is no path from a member id straight to a row.
 */
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import { Appointment, StaffProfile, Team, TeamMember } from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import type { TeamAssignmentStrategy } from '../../database/models/Team';
import { ConflictError, ErrorCode, NotFoundError } from '../../utils/errors';
import { uniqueSlug } from '../../utils/ids';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';

const log = createLogger('teams');

/** Columns a manager needs to recognise a member; never the whole profile. */
const MEMBER_PROFILE_ATTRIBUTES = [
  'id',
  'displayName',
  'title',
  'avatarUrl',
  'color',
  'timezone',
  'isBookable',
  'isActive',
] as const;

export interface TeamActor {
  userId: string;
  email: string;
}

export interface ListTeamsOptions {
  page: number;
  pageSize: number;
  search?: string;
  isActive?: boolean;
  assignmentStrategy?: TeamAssignmentStrategy;
}

export interface TeamPage {
  rows: Team[];
  page: number;
  pageSize: number;
  totalItems: number;
}

export interface TeamWithMembers {
  team: Team;
  members: TeamMember[];
}

export interface CreateTeamInput {
  name: string;
  slug?: string;
  description?: string | null;
  assignmentStrategy?: TeamAssignmentStrategy;
  isActive?: boolean;
}

export interface UpdateTeamInput {
  name?: string;
  slug?: string;
  description?: string | null;
  assignmentStrategy?: TeamAssignmentStrategy;
  isActive?: boolean;
}

export interface AddTeamMemberInput {
  staffProfileId: string;
  weight?: number;
  priority?: number;
}

export interface UpdateTeamMemberInput {
  weight?: number;
  priority?: number;
  isActive?: boolean;
}

/**
 * `%` and `_` are wildcards to LIKE, so an unescaped search term of "%" would
 * match every team instead of the one the user is looking for.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The only way a team is ever loaded. Scoping on businessId here is what makes
 * every downstream member query tenant-safe.
 */
async function findTeamOrFail(
  businessId: string,
  teamId: string,
  transaction?: Transaction,
): Promise<Team> {
  const team = await Team.findOne({ where: { id: teamId, businessId }, transaction });
  if (!team) throw new NotFoundError('Team');
  return team;
}

/**
 * A member row is meaningless without its profile, and the join is a second
 * tenant check: a profile from another workspace can never be joined in.
 */
async function loadMembers(
  businessId: string,
  teamId: string,
  transaction?: Transaction,
): Promise<TeamMember[]> {
  return TeamMember.findAll({
    where: { teamId },
    include: [
      {
        model: StaffProfile,
        as: 'staffProfile',
        required: true,
        where: { businessId },
        attributes: [...MEMBER_PROFILE_ATTRIBUTES],
      },
    ],
    order: [
      ['priority', 'ASC'],
      ['createdAt', 'ASC'],
    ],
    transaction,
  });
}

/** Appointments still occupying the calendar under this team. */
async function countActiveAppointments(
  businessId: string,
  teamId: string,
  staffProfileId: string | null,
  transaction: Transaction,
): Promise<number> {
  return Appointment.count({
    where: {
      businessId,
      teamId,
      ...(staffProfileId ? { staffProfileId } : {}),
      status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
    },
    transaction,
  });
}

export async function listTeams(businessId: string, options: ListTeamsOptions): Promise<TeamPage> {
  const term = options.search ? `%${escapeLike(options.search)}%` : null;

  const { rows, count } = await Team.findAndCountAll({
    where: {
      businessId,
      ...(options.isActive !== undefined ? { isActive: options.isActive } : {}),
      ...(options.assignmentStrategy ? { assignmentStrategy: options.assignmentStrategy } : {}),
      ...(term
        ? { [Op.or]: [{ name: { [Op.iLike]: term } }, { slug: { [Op.iLike]: term } }] }
        : {}),
    },
    order: [['name', 'ASC']],
    limit: options.pageSize,
    offset: (options.page - 1) * options.pageSize,
  });

  return { rows, page: options.page, pageSize: options.pageSize, totalItems: count };
}

export async function getTeam(businessId: string, teamId: string): Promise<TeamWithMembers> {
  const team = await findTeamOrFail(businessId, teamId);
  return { team, members: await loadMembers(businessId, team.id) };
}

export async function createTeam(
  businessId: string,
  input: CreateTeamInput,
  actor: TeamActor,
  metadata: RequestMetadata,
): Promise<Team> {
  // The audit row and the change it describes are committed together, so a
  // structural change can never exist without its trail.
  return sequelize.transaction(async (transaction) => {
    const slug = await uniqueSlug(input.slug ?? input.name, async (candidate) => {
      // Matches the partial unique index, which ignores soft-deleted teams.
      const clash = await Team.findOne({
        where: { businessId, slug: candidate },
        attributes: ['id'],
        transaction,
      });
      return clash !== null;
    });

    const team = await Team.create(
      {
        businessId,
        name: input.name,
        slug,
        description: input.description ?? null,
        // Strategy and activity fall through to the column defaults when the
        // caller did not choose, so the default lives in one place.
        ...(input.assignmentStrategy ? { assignmentStrategy: input.assignmentStrategy } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
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
        action: AuditActions.TEAM_CREATED,
        entityType: 'team',
        entityId: team.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          name: team.name,
          slug: team.slug,
          assignmentStrategy: team.assignmentStrategy,
        },
      },
      { transaction },
    );

    log.info({ businessId, teamId: team.id, slug }, 'team created');
    return team;
  });
}

export async function updateTeam(
  businessId: string,
  teamId: string,
  input: UpdateTeamInput,
  actor: TeamActor,
  metadata: RequestMetadata,
): Promise<Team> {
  return sequelize.transaction(async (transaction) => {
    const team = await findTeamOrFail(businessId, teamId, transaction);

    const before = {
      name: team.name,
      slug: team.slug,
      assignmentStrategy: team.assignmentStrategy,
      isActive: team.isActive,
    };

    let slug = team.slug;
    if (input.slug !== undefined && input.slug !== team.slug) {
      slug = await uniqueSlug(input.slug, async (candidate) => {
        const clash = await Team.findOne({
          where: { businessId, slug: candidate, id: { [Op.ne]: team.id } },
          attributes: ['id'],
          transaction,
        });
        return clash !== null;
      });
    }

    await team.update(
      {
        slug,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.assignmentStrategy !== undefined
          ? { assignmentStrategy: input.assignmentStrategy }
          : {}),
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
        action: AuditActions.TEAM_UPDATED,
        entityType: 'team',
        entityId: team.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          before,
          after: {
            name: team.name,
            slug: team.slug,
            assignmentStrategy: team.assignmentStrategy,
            isActive: team.isActive,
          },
        },
      },
      { transaction },
    );

    return team;
  });
}

export async function deleteTeam(
  businessId: string,
  teamId: string,
  actor: TeamActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const team = await findTeamOrFail(businessId, teamId, transaction);

    const activeAppointments = await countActiveAppointments(
      businessId,
      team.id,
      null,
      transaction,
    );
    if (activeAppointments > 0) {
      throw new ConflictError(
        `This team is still assigned to ${activeAppointments} active appointment(s). ` +
          'Reassign or cancel them, or deactivate the team instead.',
        ErrorCode.CONFLICT,
        { activeAppointments },
      );
    }

    // Paranoid model: the row is soft-deleted so past appointments booked
    // through the team keep a readable provider. Member rows are left in place
    // for the same reason — the team is invisible either way.
    await team.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        // No TEAM_DELETED constant exists; TEAM_UPDATED keeps the entity type
        // honest and the metadata says what actually happened.
        action: AuditActions.TEAM_UPDATED,
        entityType: 'team',
        entityId: team.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { change: 'deleted', name: team.name, slug: team.slug },
      },
      { transaction },
    );

    log.info({ businessId, teamId: team.id }, 'team deleted');
  });
}

export async function addTeamMember(
  businessId: string,
  teamId: string,
  input: AddTeamMemberInput,
  actor: TeamActor,
  metadata: RequestMetadata,
): Promise<TeamMember> {
  return sequelize.transaction(async (transaction) => {
    const team = await findTeamOrFail(businessId, teamId, transaction);

    // A staff id from another workspace must look exactly like one that does
    // not exist, so this is a 404 and not a 403.
    const staffProfile = await StaffProfile.findOne({
      where: { id: input.staffProfileId, businessId },
      attributes: ['id', 'displayName'],
      transaction,
    });
    if (!staffProfile) throw new NotFoundError('Staff profile');

    const existing = await TeamMember.findOne({
      where: { teamId: team.id, staffProfileId: staffProfile.id },
      attributes: ['id'],
      transaction,
    });
    if (existing) {
      throw new ConflictError(
        'That staff member is already in this team.',
        ErrorCode.ALREADY_EXISTS,
      );
    }

    const member = await TeamMember.create(
      {
        teamId: team.id,
        staffProfileId: staffProfile.id,
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.TEAM_UPDATED,
        entityType: 'team',
        entityId: team.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          change: 'member_added',
          teamMemberId: member.id,
          staffProfileId: staffProfile.id,
          staffName: staffProfile.displayName,
          weight: member.weight,
          priority: member.priority,
        },
      },
      { transaction },
    );

    return member;
  });
}

export async function updateTeamMember(
  businessId: string,
  teamId: string,
  memberId: string,
  input: UpdateTeamMemberInput,
  actor: TeamActor,
  metadata: RequestMetadata,
): Promise<TeamMember> {
  return sequelize.transaction(async (transaction) => {
    const team = await findTeamOrFail(businessId, teamId, transaction);

    const member = await TeamMember.findOne({
      where: { id: memberId, teamId: team.id },
      transaction,
    });
    if (!member) throw new NotFoundError('Team member');

    const before = {
      weight: member.weight,
      priority: member.priority,
      isActive: member.isActive,
    };

    await member.update(
      {
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
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
        action: AuditActions.TEAM_UPDATED,
        entityType: 'team',
        entityId: team.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          change: 'member_updated',
          teamMemberId: member.id,
          staffProfileId: member.staffProfileId,
          before,
          after: { weight: member.weight, priority: member.priority, isActive: member.isActive },
        },
      },
      { transaction },
    );

    return member;
  });
}

export async function removeTeamMember(
  businessId: string,
  teamId: string,
  memberId: string,
  actor: TeamActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const team = await findTeamOrFail(businessId, teamId, transaction);

    const member = await TeamMember.findOne({
      where: { id: memberId, teamId: team.id },
      transaction,
    });
    if (!member) throw new NotFoundError('Team member');

    const activeAppointments = await countActiveAppointments(
      businessId,
      team.id,
      member.staffProfileId,
      transaction,
    );
    if (activeAppointments > 0) {
      throw new ConflictError(
        `This member still has ${activeAppointments} active appointment(s) booked through ` +
          'the team. Reassign them, or pause the member with isActive instead.',
        ErrorCode.CONFLICT,
        { activeAppointments },
      );
    }

    // team_members has no deleted_at, and the unique index on
    // (team_id, staff_profile_id) requires the row to be gone before the same
    // person can be re-added, so removal is a hard delete.
    await member.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.TEAM_UPDATED,
        entityType: 'team',
        entityId: team.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          change: 'member_removed',
          teamMemberId: memberId,
          staffProfileId: member.staffProfileId,
        },
      },
      { transaction },
    );
  });
}
