/**
 * A date-specific exception to the recurring availability rules.
 *
 * One row covers both directions of exception: `isAvailable = false` removes
 * time that the recurring rules would otherwise offer ("on leave Tuesday"),
 * while `isAvailable = true` adds a window that replaces the usual rules for
 * that day ("working this Saturday").
 *
 * `scope` and the populated target key are kept in agreement by a database
 * check constraint, so a row can never be applied to the wrong kind of entity.
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

export const AVAILABILITY_OVERRIDE_SCOPES = ['BUSINESS', 'LOCATION', 'STAFF', 'RESOURCE'] as const;
export type AvailabilityOverrideScope = (typeof AVAILABILITY_OVERRIDE_SCOPES)[number];

export const AVAILABILITY_OVERRIDE_REASONS = [
  'LEAVE',
  'SICK',
  'HOLIDAY',
  'TRAINING',
  'MAINTENANCE',
  'EXTRA_HOURS',
  'CUSTOM',
] as const;
export type AvailabilityOverrideReason = (typeof AVAILABILITY_OVERRIDE_REASONS)[number];

export class AvailabilityOverride extends Model<
  InferAttributes<AvailabilityOverride>,
  InferCreationAttributes<AvailabilityOverride>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare scope: AvailabilityOverrideScope;
  declare staffProfileId: ForeignKey<string> | null;
  declare locationId: ForeignKey<string> | null;
  declare resourceId: ForeignKey<string> | null;
  // DATEONLY is read and written as a 'YYYY-MM-DD' string: the override belongs
  // to a local calendar day, not to an instant.
  declare date: string;
  declare isAvailable: boolean;
  declare startMinute: number | null;
  declare endMinute: number | null;
  declare reason: AvailabilityOverrideReason | null;
  declare note: string | null;
  declare createdByUserId: ForeignKey<string> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /**
   * A NULL window means the override applies to the whole day. Both minute
   * columns are NULL or both are set, which the check constraint guarantees, so
   * testing one is enough.
   */
  get isAllDay(): NonAttribute<boolean> {
    return this.startMinute === null;
  }
}

AvailabilityOverride.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    scope: { type: DataTypes.TEXT, allowNull: false },
    staffProfileId: { type: DataTypes.UUID, allowNull: true },
    locationId: { type: DataTypes.UUID, allowNull: true },
    resourceId: { type: DataTypes.UUID, allowNull: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    isAvailable: { type: DataTypes.BOOLEAN, allowNull: false },
    startMinute: { type: DataTypes.INTEGER, allowNull: true },
    endMinute: { type: DataTypes.INTEGER, allowNull: true },
    reason: { type: DataTypes.TEXT, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    createdByUserId: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'AvailabilityOverride',
    tableName: 'availability_overrides',
    underscored: true,
    // No deleted_at column: withdrawing an exception means deleting the row,
    // since a lingering soft-deleted override would still need filtering out of
    // every availability query.
    paranoid: false,
  },
);
