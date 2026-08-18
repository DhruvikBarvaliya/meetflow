/**
 * A place — physical or otherwise — where appointments happen.
 *
 * `timezone` is carried per location rather than inherited from the business:
 * a chain with branches in several regions must resolve slots against the
 * branch's local day, not the head office's.
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

export const LOCATION_TYPES = ['PHYSICAL', 'VIRTUAL', 'PHONE', 'CUSTOMER_SITE'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export class Location extends Model<InferAttributes<Location>, InferCreationAttributes<Location>> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare name: string;
  declare slug: string;
  declare type: CreationOptional<LocationType>;
  declare description: string | null;
  declare addressLine1: string | null;
  declare addressLine2: string | null;
  declare city: string | null;
  declare state: string | null;
  declare postalCode: string | null;
  declare countryCode: string | null;
  declare timezone: CreationOptional<string>;
  declare phone: string | null;
  declare email: string | null;
  declare virtualMeetingUrl: string | null;
  declare capacity: number | null;
  declare sortOrder: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /** Non-physical locations have no address to validate or display. */
  get isVirtual(): NonAttribute<boolean> {
    return this.type !== 'PHYSICAL';
  }

  /** NULL capacity means the site imposes no concurrency cap of its own. */
  get hasCapacityLimit(): NonAttribute<boolean> {
    return this.capacity !== null;
  }

  /** Single-line address for confirmations and calendar invites. */
  get formattedAddress(): NonAttribute<string | null> {
    const parts = [
      this.addressLine1,
      this.addressLine2,
      this.city,
      this.state,
      this.postalCode,
      this.countryCode,
    ].filter((part): part is string => part !== null && part.trim() !== '');
    return parts.length > 0 ? parts.join(', ') : null;
  }
}

Location.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    slug: { type: DataTypes.TEXT, allowNull: false },
    type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'PHYSICAL' },
    description: { type: DataTypes.TEXT, allowNull: true },
    addressLine1: { type: DataTypes.TEXT, allowNull: true },
    addressLine2: { type: DataTypes.TEXT, allowNull: true },
    city: { type: DataTypes.TEXT, allowNull: true },
    state: { type: DataTypes.TEXT, allowNull: true },
    postalCode: { type: DataTypes.TEXT, allowNull: true },
    countryCode: { type: DataTypes.CHAR(2), allowNull: true },
    timezone: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'UTC' },
    phone: { type: DataTypes.TEXT, allowNull: true },
    email: { type: DataTypes.CITEXT, allowNull: true },
    virtualMeetingUrl: { type: DataTypes.TEXT, allowNull: true },
    capacity: { type: DataTypes.INTEGER, allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'Location',
    tableName: 'locations',
    underscored: true,
    // Soft-deleted so historic appointments keep resolving their location.
    paranoid: true,
    scopes: {
      active: { where: { isActive: true } },
    },
  },
);
