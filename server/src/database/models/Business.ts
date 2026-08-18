/**
 * The tenant boundary.
 *
 * A Business IS the tenant: every tenant-owned table carries its id, and that id
 * is always derived from the authenticated Membership rather than from request
 * input. `timezone`, `currency` and `locale` are the workspace-wide fallbacks
 * that services, locations and booking links inherit when they set nothing of
 * their own.
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

export const BUSINESS_STATUSES = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export class Business extends Model<InferAttributes<Business>, InferCreationAttributes<Business>> {
  declare id: CreationOptional<string>;
  declare slug: string;
  declare name: string;
  declare legalName: string | null;
  declare description: string | null;
  declare industry: string | null;
  declare timezone: CreationOptional<string>;
  declare currency: CreationOptional<string>;
  declare locale: CreationOptional<string>;
  declare logoUrl: string | null;
  declare websiteUrl: string | null;
  declare supportEmail: string | null;
  declare supportPhone: string | null;
  declare status: CreationOptional<BusinessStatus>;
  /**
   * The owner is ON DELETE RESTRICT: a user account cannot disappear while it is
   * the last responsible party for a workspace's data.
   */
  declare ownerUserId: ForeignKey<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /**
   * Gate for the public booking surface. SUSPENDED and ARCHIVED workspaces stay
   * fully readable to their own staff, so status must be checked here rather
   * than assumed from the row simply existing.
   */
  get isBookable(): NonAttribute<boolean> {
    return this.status === 'ACTIVE';
  }
}

Business.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    slug: { type: DataTypes.TEXT, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    legalName: { type: DataTypes.TEXT, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    industry: { type: DataTypes.TEXT, allowNull: true },
    timezone: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'UTC' },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'USD' },
    locale: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'en-US' },
    logoUrl: { type: DataTypes.TEXT, allowNull: true },
    websiteUrl: { type: DataTypes.TEXT, allowNull: true },
    supportEmail: { type: DataTypes.CITEXT, allowNull: true },
    supportPhone: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'ACTIVE' },
    ownerUserId: { type: DataTypes.UUID, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'Business',
    tableName: 'businesses',
    underscored: true,
    // Soft delete: the slug uniqueness index is partial on deleted_at IS NULL,
    // so a removed workspace keeps its history while freeing its public handle.
    paranoid: true,
  },
);
