/**
 * Booking policy defaults for one workspace.
 *
 * This is a one-row-per-business extension table rather than columns on
 * Business: the policy is read on every availability and booking request, while
 * the Business row itself is mostly presentational. Individual services may
 * override single values; the resolver falls back here, then to engine defaults.
 *
 * The primary key is `businessId` itself — there is deliberately no surrogate id,
 * which is what makes "at most one settings row per business" a schema guarantee.
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

export class BusinessSettings extends Model<
  InferAttributes<BusinessSettings>,
  InferCreationAttributes<BusinessSettings>
> {
  declare businessId: ForeignKey<string>;
  declare slotIntervalMinutes: CreationOptional<number>;
  declare defaultPreBufferMinutes: CreationOptional<number>;
  declare defaultPostBufferMinutes: CreationOptional<number>;
  declare minNoticeMinutes: CreationOptional<number>;
  declare maxHorizonDays: CreationOptional<number>;
  declare cancellationDeadlineMinutes: CreationOptional<number>;
  declare rescheduleDeadlineMinutes: CreationOptional<number>;
  declare allowCustomerCancel: CreationOptional<boolean>;
  declare allowCustomerReschedule: CreationOptional<boolean>;
  declare maxReschedulesPerAppointment: CreationOptional<number>;
  declare requireApproval: CreationOptional<boolean>;
  /** Null means unlimited — a zero cap is rejected by the column's CHECK. */
  declare maxBookingsPerCustomerPerDay: number | null;
  declare maxBookingsPerStaffPerDay: number | null;
  declare noShowGraceMinutes: CreationOptional<number>;
  declare waitlistEnabled: CreationOptional<boolean>;
  declare waitlistHoldMinutes: CreationOptional<number>;
  declare waitlistAutoBook: CreationOptional<boolean>;
  /** Minutes before start_at at which each reminder is sent, e.g. [1440, 60]. */
  declare reminderOffsetsMinutes: CreationOptional<number[]>;
  declare branding: CreationOptional<Record<string, unknown>>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BusinessSettings.init(
  {
    businessId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    slotIntervalMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 15 },
    defaultPreBufferMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    defaultPostBufferMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    minNoticeMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    maxHorizonDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    cancellationDeadlineMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1440 },
    rescheduleDeadlineMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1440 },
    allowCustomerCancel: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    allowCustomerReschedule: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    maxReschedulesPerAppointment: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    requireApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    maxBookingsPerCustomerPerDay: { type: DataTypes.INTEGER, allowNull: true },
    maxBookingsPerStaffPerDay: { type: DataTypes.INTEGER, allowNull: true },
    noShowGraceMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 15 },
    waitlistEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    waitlistHoldMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    waitlistAutoBook: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    reminderOffsetsMinutes: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      allowNull: false,
      defaultValue: [1440, 60],
    },
    branding: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'BusinessSettings',
    tableName: 'business_settings',
    underscored: true,
    // Not paranoid: the row is cascade-deleted with its business, and a
    // soft-deleted policy row would silently fall back to engine defaults.
    paranoid: false,
  },
);
