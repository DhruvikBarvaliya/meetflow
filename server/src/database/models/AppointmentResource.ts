/**
 * Resource reservation held by an appointment (a room, a chair, a machine).
 *
 * As with staff reservations the window is denormalised onto this row — copied
 * from the appointment's buffered footprint — because the
 * `appointment_resources_no_overlap` GiST exclusion constraint can only read
 * columns of the row it guards.
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

export class AppointmentResource extends Model<
  InferAttributes<AppointmentResource>,
  InferCreationAttributes<AppointmentResource>
> {
  declare id: CreationOptional<string>;
  declare appointmentId: ForeignKey<string>;
  declare resourceId: ForeignKey<string>;
  declare quantity: CreationOptional<number>;
  declare startsAt: Date;
  declare endsAt: Date;
  /**
   * Snapshot of `resources.capacity = 1` taken at reservation time. Only
   * exclusive reservations take part in the overlap constraint; shared resources
   * are counted transactionally under a row lock instead, because an exclusion
   * constraint cannot express "at most N".
   */
  declare isExclusive: CreationOptional<boolean>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /**
   * True when this row is one the database itself will refuse to double-book —
   * the exact predicate of `appointment_resources_no_overlap`. Anything else has
   * to be capacity-checked in application code under a lock.
   */
  get isDatabaseEnforced(): NonAttribute<boolean> {
    return this.isActive && this.isExclusive;
  }
}

AppointmentResource.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    appointmentId: { type: DataTypes.UUID, allowNull: false },
    resourceId: { type: DataTypes.UUID, allowNull: false },
    quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    startsAt: { type: DataTypes.DATE, allowNull: false },
    endsAt: { type: DataTypes.DATE, allowNull: false },
    isExclusive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'AppointmentResource',
    tableName: 'appointment_resources',
    underscored: true,
    // Not paranoid: the table has no deleted_at. Releasing a resource is
    // `isActive = false`, which is what drops the row out of the exclusion
    // constraint while keeping the reservation on record.
    paranoid: false,
    scopes: {
      // Matches the `appointment_resources_calendar_idx` partial index.
      active: { where: { isActive: true } },
    },
  },
);
