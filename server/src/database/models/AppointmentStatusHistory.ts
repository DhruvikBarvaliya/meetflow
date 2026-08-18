/**
 * Append-only record of every appointment lifecycle transition.
 *
 * `businessId` is carried alongside `appointmentId` so the tenant-wide audit
 * feed can be served straight from `appointment_status_history_business_idx`
 * without joining back to appointments — the appointment's own tenant column
 * remains the source of truth.
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
import type { AppointmentStatus } from './Appointment';

export const STATUS_HISTORY_ACTOR_TYPES = [
  'CUSTOMER',
  'STAFF',
  'OWNER',
  'ADMIN',
  'SYSTEM',
] as const;
export type StatusHistoryActorType = (typeof STATUS_HISTORY_ACTOR_TYPES)[number];

export class AppointmentStatusHistory extends Model<
  InferAttributes<AppointmentStatusHistory>,
  InferCreationAttributes<AppointmentStatusHistory>
> {
  declare id: CreationOptional<string>;
  declare appointmentId: ForeignKey<string>;
  declare businessId: ForeignKey<string>;
  /** NULL on the row that records the appointment's creation. */
  declare fromStatus: AppointmentStatus | null;
  /**
   * The status columns carry no CHECK in SQL on purpose: history must stay
   * writable and readable if the vocabulary ever changes. Every transition this
   * application records uses the current vocabulary, so the union is the
   * accurate type here.
   */
  declare toStatus: AppointmentStatus;
  declare actorType: CreationOptional<StatusHistoryActorType>;
  declare actorUserId: ForeignKey<string> | null;
  /**
   * Human-readable actor for the rows no user id can describe — a customer
   * acting through a public manage link, or a named background job.
   */
  declare actorLabel: string | null;
  declare reason: string | null;
  declare metadata: CreationOptional<Record<string, unknown>>;
  declare createdAt: CreationOptional<Date>;
}

AppointmentStatusHistory.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    appointmentId: { type: DataTypes.UUID, allowNull: false },
    businessId: { type: DataTypes.UUID, allowNull: false },
    fromStatus: { type: DataTypes.TEXT, allowNull: true },
    toStatus: { type: DataTypes.TEXT, allowNull: false },
    actorType: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'SYSTEM' },
    actorUserId: { type: DataTypes.UUID, allowNull: true },
    actorLabel: { type: DataTypes.TEXT, allowNull: true },
    reason: { type: DataTypes.TEXT, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'AppointmentStatusHistory',
    tableName: 'appointment_status_history',
    underscored: true,
    // The table is immutable, so it has no updated_at column; Sequelize must be
    // told not to write one.
    updatedAt: false,
    // Not paranoid: an audit trail is never deleted, softly or otherwise.
    paranoid: false,
  },
);
