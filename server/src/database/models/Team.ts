/**
 * A group of staff that can be booked as one unit.
 *
 * `assignmentStrategy` decides how the engine turns a team-level booking into
 * concrete staff reservations; the members themselves live in TeamMember.
 */
import {
  DataTypes,
  Model,
  type CreationOptional,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../../config/database';

export const TEAM_ASSIGNMENT_STRATEGIES = [
  'ROUND_ROBIN',
  'COLLECTIVE',
  'POOLED',
  'SMART_MATCH',
] as const;
export type TeamAssignmentStrategy = (typeof TEAM_ASSIGNMENT_STRATEGIES)[number];

export class Team extends Model<InferAttributes<Team>, InferCreationAttributes<Team>> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare name: string;
  declare slug: string;
  declare description: string | null;
  declare assignmentStrategy: CreationOptional<TeamAssignmentStrategy>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /**
   * COLLECTIVE books every member at once, so availability is the intersection
   * of all members' free time instead of the union. Callers branch on this
   * rather than on the raw strategy string.
   */
  get requiresAllMembers(): NonAttribute<boolean> {
    return this.assignmentStrategy === 'COLLECTIVE';
  }
}

Team.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    slug: { type: DataTypes.TEXT, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    assignmentStrategy: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'ROUND_ROBIN' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'Team',
    tableName: 'teams',
    underscored: true,
    // Soft-deleted so past appointments booked through the team stay readable.
    paranoid: true,
    scopes: {
      active: { where: { isActive: true } },
    },
  },
);
