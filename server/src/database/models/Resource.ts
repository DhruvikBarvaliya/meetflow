/**
 * A schedulable thing that is not a person — a room, a chair, a vehicle, a
 * piece of equipment.
 *
 * Resources are reserved alongside staff for the appointment's full buffered
 * footprint, which is what stops two bookings claiming the same room.
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

export const RESOURCE_TYPES = [
  'ROOM',
  'EQUIPMENT',
  'VEHICLE',
  'DESK',
  'FACILITY',
  'OTHER',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export class Resource extends Model<InferAttributes<Resource>, InferCreationAttributes<Resource>> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare locationId: ForeignKey<string> | null;
  declare name: string;
  declare slug: string;
  declare type: CreationOptional<ResourceType>;
  declare description: string | null;
  declare capacity: CreationOptional<number>;
  declare color: string | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /**
   * A resource with no location travels with the appointment, so
   * location-filtered availability must not exclude it.
   */
  get isMobile(): NonAttribute<boolean> {
    return this.locationId === null;
  }

  /**
   * Capacity above one means concurrent appointments may hold this resource at
   * the same instant, so overlap alone is not a conflict.
   */
  get isShared(): NonAttribute<boolean> {
    return this.capacity > 1;
  }
}

Resource.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    locationId: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.TEXT, allowNull: false },
    slug: { type: DataTypes.TEXT, allowNull: false },
    type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'ROOM' },
    description: { type: DataTypes.TEXT, allowNull: true },
    capacity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    color: { type: DataTypes.TEXT, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'Resource',
    tableName: 'resources',
    underscored: true,
    // Soft-deleted so historic appointments keep the resource they reserved,
    // and so the partial unique index on (business_id, slug) frees a retired
    // resource's slug for reuse.
    paranoid: true,
    scopes: {
      active: { where: { isActive: true } },
    },
  },
);
