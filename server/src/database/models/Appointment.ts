/**
 * Appointment — the central scheduling record.
 *
 * `startsAt`/`endsAt` are what the customer sees. `bufferStartAt`/`bufferEndAt`
 * are the true calendar footprint including preparation and cleanup time, and
 * are the values copied into AppointmentStaff/AppointmentResource reservations
 * where the database's exclusion constraints enforce non-overlap.
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

export const APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'RESCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
  'REJECTED',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Statuses that occupy the calendar. Every availability query subtracts these
 * and only these; the set is exported so no call site can drift from it.
 */
export const ACTIVE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'PENDING',
  'CONFIRMED',
  'RESCHEDULED',
  'IN_PROGRESS',
];

/** Statuses from which no further transition is allowed. */
export const TERMINAL_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
  'REJECTED',
];

export const APPOINTMENT_SOURCES = [
  'PUBLIC',
  'STAFF',
  'OWNER',
  'ADMIN',
  'API',
  'WAITLIST',
] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

export const CANCELLED_BY_TYPES = ['CUSTOMER', 'STAFF', 'OWNER', 'ADMIN', 'SYSTEM'] as const;
export type CancelledByType = (typeof CANCELLED_BY_TYPES)[number];

export class Appointment extends Model<
  InferAttributes<Appointment>,
  InferCreationAttributes<Appointment>
> {
  declare id: CreationOptional<string>;
  declare publicId: string;
  declare businessId: ForeignKey<string>;
  declare serviceId: ForeignKey<string>;
  declare locationId: ForeignKey<string> | null;
  declare staffProfileId: ForeignKey<string> | null;
  declare teamId: ForeignKey<string> | null;
  declare customerId: ForeignKey<string> | null;
  declare bookingLinkId: ForeignKey<string> | null;

  declare status: CreationOptional<AppointmentStatus>;

  declare startsAt: Date;
  declare endsAt: Date;
  declare bufferStartAt: Date;
  declare bufferEndAt: Date;
  declare durationMinutes: number;
  declare preBufferMinutes: CreationOptional<number>;
  declare postBufferMinutes: CreationOptional<number>;
  declare timezone: CreationOptional<string>;

  declare capacity: CreationOptional<number>;
  declare bookedCount: CreationOptional<number>;

  declare priceAmount: CreationOptional<number>;
  declare currency: CreationOptional<string>;
  declare source: CreationOptional<AppointmentSource>;
  declare title: string | null;
  declare customerNotes: string | null;
  declare internalNotes: string | null;
  declare answers: CreationOptional<Record<string, unknown>>;
  declare requiresApproval: CreationOptional<boolean>;

  declare confirmedAt: Date | null;
  declare checkedInAt: Date | null;
  declare startedAt: Date | null;
  declare completedAt: Date | null;
  declare cancelledAt: Date | null;
  declare noShowAt: Date | null;
  declare cancellationReason: string | null;
  declare cancelledByType: CancelledByType | null;
  declare cancelledByUserId: ForeignKey<string> | null;
  declare lateCancellation: CreationOptional<boolean>;

  declare rescheduledFromId: ForeignKey<string> | null;
  declare rescheduleCount: CreationOptional<number>;

  declare idempotencyKey: string | null;
  declare createdByUserId: ForeignKey<string> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  get isActive(): NonAttribute<boolean> {
    return ACTIVE_APPOINTMENT_STATUSES.includes(this.status);
  }

  get isTerminal(): NonAttribute<boolean> {
    return TERMINAL_APPOINTMENT_STATUSES.includes(this.status);
  }

  /** Remaining places on a group appointment. Always 0 or more. */
  get remainingCapacity(): NonAttribute<number> {
    return Math.max(0, this.capacity - this.bookedCount);
  }
}

Appointment.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    publicId: { type: DataTypes.TEXT, allowNull: false },
    businessId: { type: DataTypes.UUID, allowNull: false },
    serviceId: { type: DataTypes.UUID, allowNull: false },
    locationId: { type: DataTypes.UUID, allowNull: true },
    staffProfileId: { type: DataTypes.UUID, allowNull: true },
    teamId: { type: DataTypes.UUID, allowNull: true },
    customerId: { type: DataTypes.UUID, allowNull: true },
    bookingLinkId: { type: DataTypes.UUID, allowNull: true },

    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'PENDING' },

    startsAt: { type: DataTypes.DATE, allowNull: false },
    endsAt: { type: DataTypes.DATE, allowNull: false },
    bufferStartAt: { type: DataTypes.DATE, allowNull: false },
    bufferEndAt: { type: DataTypes.DATE, allowNull: false },
    durationMinutes: { type: DataTypes.INTEGER, allowNull: false },
    preBufferMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    postBufferMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    timezone: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'UTC' },

    capacity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    bookedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    priceAmount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'USD' },
    source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'PUBLIC' },
    title: { type: DataTypes.TEXT, allowNull: true },
    customerNotes: { type: DataTypes.TEXT, allowNull: true },
    internalNotes: { type: DataTypes.TEXT, allowNull: true },
    answers: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    requiresApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    confirmedAt: { type: DataTypes.DATE, allowNull: true },
    checkedInAt: { type: DataTypes.DATE, allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    noShowAt: { type: DataTypes.DATE, allowNull: true },
    cancellationReason: { type: DataTypes.TEXT, allowNull: true },
    cancelledByType: { type: DataTypes.TEXT, allowNull: true },
    cancelledByUserId: { type: DataTypes.UUID, allowNull: true },
    lateCancellation: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    rescheduledFromId: { type: DataTypes.UUID, allowNull: true },
    rescheduleCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    idempotencyKey: { type: DataTypes.TEXT, allowNull: true },
    createdByUserId: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'Appointment',
    tableName: 'appointments',
    underscored: true,
    // Not paranoid: an appointment is never deleted. CANCELLED / REJECTED are
    // real lifecycle states that reporting and audit both depend on.
    paranoid: false,
  },
);
