/**
 * One attendee's place on an appointment.
 *
 * Group services are a single appointment with many participants, so the
 * appointment stays exclusive on the staff calendar while a class of twenty can
 * still be booked. Each participant carries its own `publicId` because every
 * attendee gets a personal manage link, and that link must not let them cancel
 * or amend anybody else's place.
 */
import {
  DataTypes,
  Model,
  Op,
  type CreationOptional,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../../config/database';

export const APPOINTMENT_PARTICIPANT_ROLES = ['ATTENDEE', 'ORGANIZER', 'GUEST'] as const;
export type AppointmentParticipantRole = (typeof APPOINTMENT_PARTICIPANT_ROLES)[number];

export const APPOINTMENT_PARTICIPANT_STATUSES = [
  'BOOKED',
  'CANCELLED',
  'ATTENDED',
  'NO_SHOW',
] as const;
export type AppointmentParticipantStatus = (typeof APPOINTMENT_PARTICIPANT_STATUSES)[number];

export class AppointmentParticipant extends Model<
  InferAttributes<AppointmentParticipant>,
  InferCreationAttributes<AppointmentParticipant>
> {
  declare id: CreationOptional<string>;
  declare appointmentId: ForeignKey<string>;
  declare customerId: ForeignKey<string>;
  declare publicId: string;
  declare role: CreationOptional<AppointmentParticipantRole>;
  declare status: CreationOptional<AppointmentParticipantStatus>;
  declare answers: CreationOptional<Record<string, unknown>>;
  declare joinedAt: CreationOptional<Date>;
  declare cancelledAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /**
   * Whether this row still consumes one of the appointment's places. Mirrors the
   * `appointment_participants_active_unique` predicate (`status <> 'CANCELLED'`),
   * which is what lets a customer re-join after cancelling but never hold two
   * places at once — capacity maths must use the same rule the index does.
   */
  get holdsPlace(): NonAttribute<boolean> {
    return this.status !== 'CANCELLED';
  }
}

AppointmentParticipant.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    appointmentId: { type: DataTypes.UUID, allowNull: false },
    customerId: { type: DataTypes.UUID, allowNull: false },
    publicId: { type: DataTypes.TEXT, allowNull: false },
    role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'ATTENDEE' },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'BOOKED' },
    answers: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    joinedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'AppointmentParticipant',
    tableName: 'appointment_participants',
    underscored: true,
    // Not paranoid: the table has no deleted_at. Leaving is modelled as the
    // CANCELLED status so attendance history survives for reporting.
    paranoid: false,
    scopes: {
      // The rows that count towards capacity; the predicate is kept identical to
      // `appointment_participants_active_unique` so the index can serve it.
      active: { where: { status: { [Op.ne]: 'CANCELLED' } } },
    },
  },
);
