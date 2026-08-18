/**
 * Recurring weekly working hours for one staff member.
 *
 * Like business hours, the window is minutes from local midnight against the
 * staff member's timezone, so the rule means the same clock time either side of
 * a DST change.
 *
 * `effectiveFrom`/`effectiveTo` bound the validity of the rule so a schedule
 * change can be entered ahead of time without erasing what the schedule used to
 * be — appointments already booked under the old rule stay explicable.
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

const MINUTES_PER_DAY = 1440;

export class StaffAvailabilityRule extends Model<
  InferAttributes<StaffAvailabilityRule>,
  InferCreationAttributes<StaffAvailabilityRule>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  declare staffProfileId: ForeignKey<string>;
  /** NULL means the staff member works this window at any location. */
  declare locationId: ForeignKey<string> | null;
  declare dayOfWeek: number;
  declare startMinute: number;
  declare endMinute: number;
  // DATEONLY columns are read and written as 'YYYY-MM-DD' strings; keeping them
  // as strings avoids a Date object silently acquiring a timezone.
  declare effectiveFrom: string | null;
  declare effectiveTo: string | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /** True when the window runs past local midnight (stored as > 1440). */
  get crossesMidnight(): NonAttribute<boolean> {
    return this.endMinute > MINUTES_PER_DAY;
  }

  get durationMinutes(): NonAttribute<number> {
    return this.endMinute - this.startMinute;
  }

  /**
   * Whether this rule governs a given calendar day. ISO 'YYYY-MM-DD' strings
   * compare correctly with `<=`, which is why the bounds are not parsed here.
   */
  isEffectiveOn(isoDate: string): NonAttribute<boolean> {
    if (this.effectiveFrom !== null && isoDate < this.effectiveFrom) return false;
    if (this.effectiveTo !== null && isoDate > this.effectiveTo) return false;
    return true;
  }
}

StaffAvailabilityRule.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    staffProfileId: { type: DataTypes.UUID, allowNull: false },
    locationId: { type: DataTypes.UUID, allowNull: true },
    dayOfWeek: { type: DataTypes.SMALLINT, allowNull: false },
    startMinute: { type: DataTypes.INTEGER, allowNull: false },
    endMinute: { type: DataTypes.INTEGER, allowNull: false },
    effectiveFrom: { type: DataTypes.DATEONLY, allowNull: true },
    effectiveTo: { type: DataTypes.DATEONLY, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'StaffAvailabilityRule',
    tableName: 'staff_availability_rules',
    underscored: true,
    // No deleted_at column: superseded rules are closed off with effective_to
    // or deactivated, never removed.
    paranoid: false,
    scopes: {
      // Matches staff_availability_lookup_idx; date-range filtering still has
      // to be applied by the caller for the day being resolved.
      active: { where: { isActive: true } },
    },
  },
);
