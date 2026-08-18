/**
 * Membership of a staff profile in a team, plus the tuning the assignment
 * engine reads: `weight` skews round-robin share, `priority` breaks ties.
 */
import {
  DataTypes,
  Model,
  type CreationOptional,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../../config/database';

export class TeamMember extends Model<
  InferAttributes<TeamMember>,
  InferCreationAttributes<TeamMember>
> {
  declare id: CreationOptional<string>;
  declare teamId: ForeignKey<string>;
  declare staffProfileId: ForeignKey<string>;
  declare weight: CreationOptional<number>;
  declare priority: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

TeamMember.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    teamId: { type: DataTypes.UUID, allowNull: false },
    staffProfileId: { type: DataTypes.UUID, allowNull: false },
    weight: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'TeamMember',
    tableName: 'team_members',
    underscored: true,
    // Not paranoid: the join row has no deleted_at, and the unique index on
    // (team_id, staff_profile_id) requires a removed member's row to be gone
    // so the same person can be re-added. `isActive` covers pausing instead.
    paranoid: false,
    scopes: {
      active: { where: { isActive: true } },
    },
  },
);
