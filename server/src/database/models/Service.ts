/**
 * A bookable offering and every scheduling rule specific to it.
 *
 * `preBufferMinutes`, `postBufferMinutes`, `minNoticeMinutes`, `maxHorizonDays`,
 * `slotIntervalMinutes` and `maxPerCustomerPerDay` are nullable overrides: NULL
 * means "inherit from business_settings", 0 means "explicitly none". Resolution
 * therefore has to test for null, never for falsiness.
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

export const ASSIGNMENT_STRATEGIES = [
  'ROUND_ROBIN',
  'COLLECTIVE',
  'POOLED',
  'SMART_MATCH',
] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

export class Service extends Model<InferAttributes<Service>, InferCreationAttributes<Service>> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare categoryId: ForeignKey<string> | null;
  declare name: string;
  declare slug: string;
  declare description: string | null;
  declare durationMinutes: number;
  declare preBufferMinutes: number | null;
  declare postBufferMinutes: number | null;
  declare priceAmount: CreationOptional<number>;
  declare currency: CreationOptional<string>;
  declare capacity: CreationOptional<number>;
  declare minNoticeMinutes: number | null;
  declare maxHorizonDays: number | null;
  declare slotIntervalMinutes: number | null;
  declare maxPerCustomerPerDay: number | null;
  declare requiresApproval: CreationOptional<boolean>;
  declare assignmentStrategy: CreationOptional<AssignmentStrategy>;
  declare color: string | null;
  declare isPublic: CreationOptional<boolean>;
  declare isActive: CreationOptional<boolean>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  /**
   * Both flags must hold before this service may be offered on a public booking
   * page: a service can be retired entirely, or stay active while being sold
   * only through internal/staff booking.
   */
  get isPubliclyBookable(): NonAttribute<boolean> {
    return this.isActive && this.isPublic;
  }

  /**
   * Capacity above one turns a booking into a group session — one appointment
   * shared by many participants — which changes how availability is counted.
   */
  get isGroupService(): NonAttribute<boolean> {
    return this.capacity > 1;
  }
}

Service.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    categoryId: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.TEXT, allowNull: false },
    slug: { type: DataTypes.TEXT, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    durationMinutes: { type: DataTypes.INTEGER, allowNull: false },
    preBufferMinutes: { type: DataTypes.INTEGER, allowNull: true },
    postBufferMinutes: { type: DataTypes.INTEGER, allowNull: true },
    priceAmount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'USD' },
    capacity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    minNoticeMinutes: { type: DataTypes.INTEGER, allowNull: true },
    maxHorizonDays: { type: DataTypes.INTEGER, allowNull: true },
    slotIntervalMinutes: { type: DataTypes.INTEGER, allowNull: true },
    maxPerCustomerPerDay: { type: DataTypes.INTEGER, allowNull: true },
    requiresApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    assignmentStrategy: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'SMART_MATCH' },
    color: { type: DataTypes.TEXT, allowNull: true },
    isPublic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'Service',
    tableName: 'services',
    underscored: true,
    // Soft-deleted so past appointments keep the service they were booked
    // against, and so the partial unique index on (business_id, slug) frees the
    // slug of a retired service for reuse.
    paranoid: true,
    scopes: {
      // Mirrors services_business_active_idx, the access path behind every
      // public catalogue listing.
      publiclyBookable: { where: { isActive: true, isPublic: true } },
    },
  },
);
