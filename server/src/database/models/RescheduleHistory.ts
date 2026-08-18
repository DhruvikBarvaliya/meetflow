/**
 * Append-only record of every time an appointment was moved.
 *
 * A reschedule keeps the appointment's identity — the customer's management
 * link must never break — so the before/after values live here rather than in a
 * replacement row. `businessId` is carried alongside `appointmentId` so the
 * tenant-wide feed can be served from `reschedule_history_business_idx` without
 * joining back to appointments.
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

export const RESCHEDULE_ACTOR_TYPES = ['CUSTOMER', 'STAFF', 'OWNER', 'ADMIN', 'SYSTEM'] as const;
export type RescheduleActorType = (typeof RESCHEDULE_ACTOR_TYPES)[number];

export class RescheduleHistory extends Model<
  InferAttributes<RescheduleHistory>,
  InferCreationAttributes<RescheduleHistory>
> {
  declare id: CreationOptional<string>;
  declare appointmentId: ForeignKey<string>;
  declare businessId: ForeignKey<string>;
  declare previousStartsAt: Date;
  declare previousEndsAt: Date;
  declare newStartsAt: Date;
  declare newEndsAt: Date;
  declare previousStaffProfileId: ForeignKey<string> | null;
  declare newStaffProfileId: ForeignKey<string> | null;
  declare previousLocationId: ForeignKey<string> | null;
  declare newLocationId: ForeignKey<string> | null;
  declare reason: string | null;
  declare actorType: CreationOptional<RescheduleActorType>;
  declare actorUserId: ForeignKey<string> | null;
  /** True when the move broke the business's configured reschedule deadline. */
  declare lateReschedule: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;

  /**
   * Signed distance the appointment travelled, in minutes: negative when it was
   * pulled earlier. Reporting reads "how far do customers move bookings" off
   * this rather than re-deriving it at every call site.
   */
  get shiftMinutes(): NonAttribute<number> {
    return Math.round((this.newStartsAt.getTime() - this.previousStartsAt.getTime()) / 60_000);
  }

  /**
   * A provider swap, not just a time move. The two are recorded on one row, so
   * notifications need this to decide whether to introduce the new provider.
   */
  get changedStaff(): NonAttribute<boolean> {
    return this.previousStaffProfileId !== this.newStaffProfileId;
  }
}

RescheduleHistory.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    appointmentId: { type: DataTypes.UUID, allowNull: false },
    businessId: { type: DataTypes.UUID, allowNull: false },
    previousStartsAt: { type: DataTypes.DATE, allowNull: false },
    previousEndsAt: { type: DataTypes.DATE, allowNull: false },
    newStartsAt: { type: DataTypes.DATE, allowNull: false },
    newEndsAt: { type: DataTypes.DATE, allowNull: false },
    previousStaffProfileId: { type: DataTypes.UUID, allowNull: true },
    newStaffProfileId: { type: DataTypes.UUID, allowNull: true },
    previousLocationId: { type: DataTypes.UUID, allowNull: true },
    newLocationId: { type: DataTypes.UUID, allowNull: true },
    reason: { type: DataTypes.TEXT, allowNull: true },
    actorType: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'SYSTEM' },
    actorUserId: { type: DataTypes.UUID, allowNull: true },
    lateReschedule: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'RescheduleHistory',
    tableName: 'reschedule_history',
    underscored: true,
    // The table is immutable, so it has no updated_at column; Sequelize must be
    // told not to write one.
    updatedAt: false,
    // Not paranoid: an audit trail is never deleted, softly or otherwise.
    paranoid: false,
  },
);
