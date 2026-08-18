/**
 * Staff reservation on an appointment — the row PostgreSQL actually polices.
 *
 * `startsAt`/`endsAt` duplicate the appointment's *buffered* window instead of
 * being read through a join, because the `appointment_staff_no_overlap` GiST
 * exclusion constraint can only see columns of its own row. Writers must copy
 * the appointment's bufferStartAt/bufferEndAt here — copying the customer-facing
 * startsAt/endsAt would silently stop preparation and cleanup time from being
 * protected against back-to-back bookings.
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

export const APPOINTMENT_STAFF_ROLES = ['PRIMARY', 'ASSISTANT', 'OBSERVER'] as const;
export type AppointmentStaffRole = (typeof APPOINTMENT_STAFF_ROLES)[number];

export class AppointmentStaff extends Model<
  InferAttributes<AppointmentStaff>,
  InferCreationAttributes<AppointmentStaff>
> {
  declare id: CreationOptional<string>;
  declare appointmentId: ForeignKey<string>;
  declare staffProfileId: ForeignKey<string>;
  declare role: CreationOptional<AppointmentStaffRole>;
  declare startsAt: Date;
  declare endsAt: Date;
  /**
   * Cleared rather than deleted once an appointment is cancelled or completed:
   * the assignment stays auditable while the exclusion constraint — which is
   * declared `WHERE (is_blocking)` — releases the calendar slot.
   */
  declare isBlocking: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

AppointmentStaff.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    appointmentId: { type: DataTypes.UUID, allowNull: false },
    staffProfileId: { type: DataTypes.UUID, allowNull: false },
    role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'PRIMARY' },
    startsAt: { type: DataTypes.DATE, allowNull: false },
    endsAt: { type: DataTypes.DATE, allowNull: false },
    isBlocking: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'AppointmentStaff',
    tableName: 'appointment_staff',
    underscored: true,
    // Not paranoid: the table has no deleted_at, and a soft-deleted row would
    // still occupy the exclusion constraint and keep the slot unbookable.
    paranoid: false,
    scopes: {
      // Matches the `appointment_staff_calendar_idx` partial index, so calendar
      // and availability queries stay on it.
      blocking: { where: { isBlocking: true } },
    },
  },
);
