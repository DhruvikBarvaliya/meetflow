/**
 * The authenticated link between a user and a tenant.
 *
 * This row is the only source of tenant context for management APIs: the
 * business_id used by every scoped query comes from here, never from the client.
 * A user may hold one live membership per business — the unique index is partial
 * on deleted_at IS NULL, so a removed member can later be re-invited.
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

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export class Membership extends Model<
  InferAttributes<Membership>,
  InferCreationAttributes<Membership>
> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<string>;
  declare businessId: ForeignKey<string>;
  declare roleId: ForeignKey<string>;
  declare status: CreationOptional<MembershipStatus>;
  declare invitedByUserId: ForeignKey<string> | null;
  declare invitedAt: Date | null;
  declare joinedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /**
   * The single check every tenant-scoped request makes before trusting this row
   * for authorisation. INVITED members have not accepted yet and SUSPENDED ones
   * keep their row purely so their history and assignments survive.
   */
  get isActive(): NonAttribute<boolean> {
    return this.status === 'ACTIVE';
  }
}

Membership.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    businessId: { type: DataTypes.UUID, allowNull: false },
    roleId: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'ACTIVE' },
    invitedByUserId: { type: DataTypes.UUID, allowNull: true },
    invitedAt: { type: DataTypes.DATE, allowNull: true },
    joinedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'Membership',
    tableName: 'memberships',
    underscored: true,
    // Soft delete: appointments and audit entries attribute work to a membership
    // long after the person has left the workspace.
    paranoid: true,
  },
);
