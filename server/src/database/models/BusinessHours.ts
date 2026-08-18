/**
 * Opening hours of a business, expressed as a repeating weekly wall-clock rule.
 *
 * Windows are stored as minutes from local midnight rather than as times or
 * instants, so "we open at 09:00" survives a DST transition unchanged — the
 * pair is resolved against the location's IANA zone at query time.
 *
 * Several rows may share a weekday: a split shift with a midday closure is two
 * rows, not one row with a gap.
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

/** Minutes in a day; `endMinute` beyond this rolls into the following day. */
const MINUTES_PER_DAY = 1440;

export class BusinessHours extends Model<
  InferAttributes<BusinessHours>,
  InferCreationAttributes<BusinessHours>
> {
  declare id: CreationOptional<string>;
  declare businessId: ForeignKey<string>;
  /** NULL applies the row business-wide; any row for a location replaces the
   * business-wide rows for that location entirely. */
  declare locationId: ForeignKey<string> | null;
  declare dayOfWeek: number;
  declare startMinute: number;
  declare endMinute: number;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /**
   * True when the window runs past local midnight (22:00–02:00 is stored as
   * 1320–1560). Callers that map a window onto a calendar day must split it.
   */
  get crossesMidnight(): NonAttribute<boolean> {
    return this.endMinute > MINUTES_PER_DAY;
  }

  get durationMinutes(): NonAttribute<number> {
    return this.endMinute - this.startMinute;
  }
}

BusinessHours.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.UUID, allowNull: false },
    locationId: { type: DataTypes.UUID, allowNull: true },
    dayOfWeek: { type: DataTypes.SMALLINT, allowNull: false },
    startMinute: { type: DataTypes.INTEGER, allowNull: false },
    endMinute: { type: DataTypes.INTEGER, allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'BusinessHours',
    tableName: 'business_hours',
    underscored: true,
    // No deleted_at column: a rule that no longer applies is deactivated via
    // is_active, which keeps the unique window index meaningful.
    paranoid: false,
    scopes: {
      // Mirrors the business_hours_lookup_idx access path used by availability
      // resolution, which never considers deactivated rows.
      active: { where: { isActive: true } },
    },
  },
);
