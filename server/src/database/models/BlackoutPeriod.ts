/**
 * An absolute span during which a business, location, staff member or resource
 * is unavailable: maintenance windows, multi-day leave, offsite events.
 *
 * Unlike business hours and availability rules, the bounds are instants rather
 * than wall-clock minutes, because a span such as "shut from Friday 14:00 UTC
 * until Monday 08:00 UTC" is a stretch of real time and does not repeat on a
 * clock. Overlap is answered by the GiST index on tstzrange(starts_at, ends_at).
 *
 * `scope` and the populated target key are kept in agreement by a database
 * check constraint.
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

export const BLACKOUT_SCOPES = ['BUSINESS', 'LOCATION', 'STAFF', 'RESOURCE'] as const;
export type BlackoutScope = (typeof BLACKOUT_SCOPES)[number];

export const BLACKOUT_REASONS = [
  'LEAVE',
  'SICK',
  'MAINTENANCE',
  'CLOSURE',
  'TRAINING',
  'EVENT',
  'CUSTOM',
] as const;
export type BlackoutReason = (typeof BLACKOUT_REASONS)[number];

export class BlackoutPeriod extends Model<
  InferAttributes<BlackoutPeriod>,
  InferCreationAttributes<BlackoutPeriod>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare scope: BlackoutScope;
  declare staffProfileId: ForeignKey<string> | null;
  declare locationId: ForeignKey<string> | null;
  declare resourceId: ForeignKey<string> | null;
  declare startsAt: Date;
  declare endsAt: Date;
  declare reason: CreationOptional<BlackoutReason>;
  declare note: string | null;
  declare createdByUserId: ForeignKey<string> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  get isActiveNow(): NonAttribute<boolean> {
    const now = Date.now();
    return this.startsAt.getTime() <= now && this.endsAt.getTime() > now;
  }

  /**
   * Half-open overlap test — a blackout ending exactly when a slot starts does
   * not block it. Matches the `[)` semantics of the tstzrange index, so an
   * in-memory check and a database check cannot disagree.
   */
  overlaps(start: Date, end: Date): NonAttribute<boolean> {
    return this.startsAt.getTime() < end.getTime() && this.endsAt.getTime() > start.getTime();
  }
}

BlackoutPeriod.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    scope: { type: DataTypes.TEXT, allowNull: false },
    staffProfileId: { type: DataTypes.UUID, allowNull: true },
    locationId: { type: DataTypes.UUID, allowNull: true },
    resourceId: { type: DataTypes.UUID, allowNull: true },
    startsAt: { type: DataTypes.DATE, allowNull: false },
    endsAt: { type: DataTypes.DATE, allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'CUSTOM' },
    note: { type: DataTypes.TEXT, allowNull: true },
    createdByUserId: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'BlackoutPeriod',
    tableName: 'blackout_periods',
    underscored: true,
    // No deleted_at column: lifting a blackout means deleting the row, and a
    // soft-deleted span would still have to be excluded from every overlap
    // query the scheduling engine runs.
    paranoid: false,
  },
);
